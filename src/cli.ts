#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { InspectorError, toInspectorError } from './core/errors.ts';
import { accessibilityIssues, describeNode, findAll, parseHierarchy } from './core/hierarchy.ts';
import { generateLocators } from './core/locators.ts';
import { ElementRepository } from './core/repository.ts';
import { DEFAULT_APPIUM_URL } from './core/sessions.ts';
import type { UiNode } from './core/types.ts';
import { WebDriverClient } from './core/webdriver.ts';
import { mapElementsToCode, scanProject } from './integration/scanner.ts';
import { adbPath } from './platforms/android.ts';
import { installedAppiumDrivers } from './platforms/common.ts';
import { adapterFor, assertPlatform } from './platforms/index.ts';
import { applyHealing, type HealingEntry } from './repair/healing-report.ts';
import { Healer, type RepairRecord } from './repair/healer.ts';
import { which } from './util/exec.ts';

const HELP = `ElementIQ Inspector CLI

Usage: elementiq <command> [options]

  doctor                                   Check Appium, drivers, adb, Xcode and build tools
  devices   --platform android|ios         Discover devices (reports missing tools/devices explicitly)
  inspect   --platform P --source page.xml [--node ID]
                                           Print the hierarchy, or locators for one node
  capture   --platform P --source page.xml --match key=value --name N --screen S [--purpose T] [--screenshot s.png]
                                           Record an element from a captured page source into the repository
  scan      --root DIR                     Detect framework/build and map repository elements to code
  repair    --root DIR --platform P --element NAME|ID --source page.xml [--dry-run] [--skip-tests] [--allow-shared]
                                           Repair broken locators using the current page source
  repairs   --root DIR                     List repair audit records
  rollback  --root DIR --id REPAIR_ID [--force]
  apply-healing --report healing-report.json
                                           Promote runtime-healing fallbacks reported by the ElementIQ framework
                                           to primary locators (use --data to point at the framework's repository)
  export    --out bundle.json              Export the element repository (with screenshots)
  import    --in bundle.json [--replace]   Import a repository bundle (merge by default)

Global: --data DIR (repository location; default ./.elementiq/data or $ELEMENTIQ_DATA), --json
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    platform: { type: 'string' }, source: { type: 'string' }, node: { type: 'string' }, match: { type: 'string', multiple: true },
    name: { type: 'string' }, screen: { type: 'string' }, purpose: { type: 'string' }, screenshot: { type: 'string' },
    root: { type: 'string' }, element: { type: 'string' }, id: { type: 'string' }, out: { type: 'string' }, in: { type: 'string' }, report: { type: 'string' },
    data: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'skip-tests': { type: 'boolean' }, 'allow-shared': { type: 'boolean' },
    force: { type: 'boolean' }, replace: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});

const dataDir = path.resolve(o.data ?? process.env.ELEMENTIQ_DATA ?? path.join(process.cwd(), '.elementiq', 'data'));
const repo = () => new ElementRepository(dataDir);
const need = (k: keyof typeof o): string => {
  const v = o[k];
  if (typeof v !== 'string' || !v) throw new InspectorError('INVALID_INPUT', `--${k} is required.`);
  return v;
};
const out = (data: unknown, text: () => string) => console.log(o.json ? JSON.stringify(data, null, 2) : text());

function loadTree() {
  const platform = assertPlatform(need('platform'));
  return parseHierarchy(readFileSync(need('source'), 'utf8'), platform);
}

function printRepair(r: RepairRecord): string {
  const lines = [`[${r.platform}] ${r.elementName}: ${r.status.toUpperCase()}`, `  ${r.message}`];
  if (r.match) lines.push(`  matched ${r.match.summary} (score ${r.match.score}, margin ${r.match.margin})`);
  for (const c of r.match?.changes ?? []) lines.push(`    changed ${c.field}: ${c.before} -> ${c.after}`);
  for (const x of r.refs) {
    lines.push(`  ${x.file}:${x.line} ${x.field ?? ''} ${x.strategy}="${x.value}" [${x.state}, ${x.action}]${x.newLocator ? ` -> ${x.newLocator.strategy}="${x.newLocator.value}"` : ''}`);
    if (x.note) lines.push(`    note: ${x.note}`);
  }
  if (r.diff) lines.push('', r.diff);
  if (r.build) lines.push(`  build: ${r.build.status} - ${r.build.reason}${r.build.command ? ` (${r.build.command})` : ''}`);
  for (const [p, t] of Object.entries(r.tests)) lines.push(`  ${p} tests: ${t!.status} - ${t!.reason}${t!.command ? ` (${t!.command})` : ''}`);
  if (r.rollback.performedAt) lines.push(`  rolled back: ${r.rollback.reason}`);
  for (const c of r.rollback.conflicts) lines.push(`  conflict: ${c}`);
  lines.push(`  audit: ${path.join(r.projectRoot, '.elementiq', 'repairs', r.id)}`);
  return lines.join('\n');
}

async function main() {
  const cmd = positionals[0];
  if (!cmd || o.help) return console.log(HELP);
  switch (cmd) {
    case 'doctor': {
      const status = await new WebDriverClient(DEFAULT_APPIUM_URL).status().then((s) => `reachable (${s.build?.version ?? '?'})`, (e) => `NOT reachable: ${(e as Error).message}`);
      const drivers = await installedAppiumDrivers();
      const rows: [string, string][] = [
        ['host', `${process.platform} / node ${process.version}`],
        ['appium cli', which('appium') ?? 'NOT FOUND (npm i -g appium)'],
        ['appium server', `${DEFAULT_APPIUM_URL} ${status}`],
        ['uiautomator2 driver', drivers ? (drivers.uiautomator2 ? 'installed' : 'NOT INSTALLED (appium driver install uiautomator2)') : 'unknown'],
        ['xcuitest driver', drivers ? (drivers.xcuitest ? 'installed' : process.platform === 'darwin' ? 'NOT INSTALLED (appium driver install xcuitest)' : 'not installed (needs a macOS Appium host)') : 'unknown'],
        ['adb', adbPath() ?? 'NOT FOUND (install platform-tools, set ANDROID_HOME)'],
        ['xcrun', process.platform === 'darwin' ? which('xcrun') ?? 'NOT FOUND' : 'n/a on this OS (iOS needs a Mac)'],
        ...(['java', 'mvn', 'gradle', 'python'] as const).map((t): [string, string] => [t, which(t) ?? 'not found']),
      ];
      return out(Object.fromEntries(rows), () => rows.map(([k, v]) => `${k.padEnd(20)} ${v}`).join('\n'));
    }
    case 'devices': {
      const d = await adapterFor(need('platform')).discover();
      return out(d, () => [
        ...d.devices.map((x) => `${x.usable ? '✓' : '✗'} ${x.kind.padEnd(9)} ${x.udid}  ${x.name}  ${x.osVersion}  [${x.state}]${x.notes.map((n) => `\n    ${n}`).join('')}`),
        d.devices.length ? '' : `No ${d.platform} devices found.`,
        ...d.issues.map((i) => `! ${i.code}: ${i.message}${i.hint ? `\n    hint: ${i.hint}` : ''}`),
      ].filter(Boolean).join('\n'));
    }
    case 'inspect': {
      const tree = loadTree();
      if (o.node) {
        const node = tree.nodes.get(o.node);
        if (!node) throw new InspectorError('ELEMENT_NOT_FOUND', `No node ${o.node}.`);
        const loc = generateLocators(tree, node);
        return out({ node, issues: accessibilityIssues(node, tree.platform), locators: loc }, () => [
          describeNode(node, tree.platform),
          ...accessibilityIssues(node, tree.platform).map((i) => `! ${i}`),
          ...loc.map((c) => `${c.unique ? '✓' : '✗'} r${c.rank} ${String(c.score).padStart(3)}  ${c.strategy}: ${c.value}${c.warnings.map((w) => `\n      ⚠ ${w}`).join('')}`),
        ].join('\n'));
      }
      const lines: string[] = [];
      const walk = (n: UiNode) => {
        lines.push(`${'  '.repeat(n.depth)}${n.id}  ${describeNode(n, tree.platform)}`);
        n.children.forEach(walk);
      };
      walk(tree.root);
      return out(tree.root, () => lines.join('\n'));
    }
    case 'capture': {
      const tree = loadTree();
      const attrs = Object.fromEntries((o.match ?? []).map((m) => [m.slice(0, m.indexOf('=')), m.slice(m.indexOf('=') + 1)]));
      const hits = findAll(tree, { attrs });
      if (hits.length !== 1) throw new InspectorError('ELEMENT_NOT_FOUND', `--match must identify exactly one element; it matched ${hits.length}.`, { platform: tree.platform });
      const r = repo();
      const existing = r.findByName(need('name'));
      const { element, changes } = r.capture({
        platform: tree.platform, tree, node: hits[0], name: need('name'), screen: need('screen'), purpose: o.purpose, elementId: existing?.id,
        device: null, appId: null, screenshotBase64: o.screenshot ? readFileSync(o.screenshot).toString('base64') : null, source: 'offline-snapshot',
      });
      return out({ element, changes }, () => `Captured ${element.name} for ${tree.platform} (${element.id}). Primary locator: ${element.platforms[tree.platform]!.locators[0].strategy}="${element.platforms[tree.platform]!.locators[0].value}"${changes.length ? `\nChanged since previous capture: ${changes.map((c) => c.field).join(', ')}` : ''}`);
    }
    case 'scan': {
      const { project, refs } = scanProject(need('root'));
      const r = repo();
      const { mappings, unmapped } = mapElementsToCode(r.elements(), refs);
      const rel = (f: string) => path.relative(project.root, f);
      return out({ project, refs, mappings, unmapped }, () => [
        `Project: ${project.root}`,
        `Build: ${project.buildSystem}   Languages: ${project.languages.join(', ')}   Frameworks: ${project.frameworks.join(', ') || 'none detected'}`,
        `Page/screen objects: ${project.pageObjects.map(rel).join(', ') || 'none'}`,
        `Tests: ${project.testFiles.map(rel).join(', ') || 'none'}`,
        '', 'Locators found:',
        ...refs.map((x) => `  [${x.platform}] ${rel(x.file)}:${x.line} ${x.owner}.${x.field ?? '?'}  ${x.strategy}="${x.value}"`),
        '', 'Repository mapping:',
        ...mappings.map((m) => `  ${m.name} [${m.platform}] -> ${m.refs.map((x) => `${rel(x.file)}:${x.line}`).join(', ') || 'NO CODE REFERENCE'}`),
        `  ${unmapped.length} code locator(s) not in the repository`,
      ].join('\n'));
    }
    case 'repair': {
      const tree = loadTree();
      const r = repo();
      const key = need('element');
      const el = r.elements().find((e) => e.id === key) ?? r.findByName(key);
      if (!el) throw new InspectorError('INVALID_INPUT', `No repository element named or identified "${key}".`);
      const rec = await new Healer(r).repair({
        projectRoot: need('root'), platform: tree.platform, elementId: el.id, tree, hierarchySource: 'offline-snapshot',
        dryRun: o['dry-run'], skipTests: o['skip-tests'], allowSharedEdits: o['allow-shared'],
      });
      out(rec, () => printRepair(rec));
      process.exitCode = rec.status === 'rolled-back' || rec.status === 'ambiguous' || rec.status === 'blocked' ? 2 : 0;
      return;
    }
    case 'repairs': {
      const list = new Healer(repo()).list(need('root'));
      return out(list, () => list.map((r) => `${r.id}  [${r.platform}] ${r.elementName}  ${r.status}  ${r.message}`).join('\n') || 'No repairs.');
    }
    case 'rollback': {
      const rec = new Healer(repo()).rollback(need('root'), need('id'), o.force);
      return out(rec, () => printRepair(rec));
    }
    case 'apply-healing': {
      const report = JSON.parse(readFileSync(need('report'), 'utf8')) as { format?: string; entries?: HealingEntry[] };
      if (report.format !== 'elementiq-healing-report') throw new InspectorError('INVALID_INPUT', `${o.report} is not an ElementIQ healing report.`);
      const results = applyHealing(repo(), report.entries ?? []);
      return out(results, () => results.map((r) => `${r.result.padEnd(9)} ${r.element} [${r.platform}] ${r.detail}`).join('\n') || 'Report has no entries.');
    }
    case 'export': {
      writeFileSync(need('out'), JSON.stringify(repo().exportBundle(), null, 2));
      return console.log(`Exported repository to ${o.out}`);
    }
    case 'import': {
      const r = repo().importBundle(JSON.parse(readFileSync(need('in'), 'utf8')), o.replace ? 'replace' : 'merge');
      return console.log(`Imported ${r.elements} element(s), ${r.tests} test(s) into ${dataDir}`);
    }
    default:
      throw new InspectorError('INVALID_INPUT', `Unknown command "${cmd}". Run with --help.`);
  }
}

main().catch((e) => {
  const err = toInspectorError(e);
  console.error(`error ${err.code}: ${err.message}${err.hint ? `\nhint: ${err.hint}` : ''}`);
  process.exitCode = 1;
});
