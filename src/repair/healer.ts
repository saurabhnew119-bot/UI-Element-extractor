import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { InspectorError } from '../core/errors.ts';
import { fingerprint } from '../core/hierarchy.ts';
import { bestLocator, evaluateOffline, generateLocators } from '../core/locators.ts';
import { compareFingerprints, ElementRepository, type FingerprintChange } from '../core/repository.ts';
import type { CodeRef, ElementSnapshot, LocatorCandidate, LocatorStrategy, Platform, UiTree } from '../core/types.ts';
import type { ProjectInfo } from '../integration/detect.ts';
import { buildCheck, findAffectedTests, loadConfig, runAffectedTests, type ProjectConfig, type StepResult } from '../integration/runner.ts';
import { refMatchesLocator, scanProject } from '../integration/scanner.ts';
import { unifiedDiff } from '../util/diff.ts';
import { MIN_MARGIN, MIN_SCORE, rankMatches, type MatchCandidate } from './matcher.ts';
import { applyEdits, CROSS_PLATFORM_STRATEGIES, renderEdits, type Edit } from './rewrite.ts';

export type RepairStatus =
  | 'not-broken'      // every code reference still resolves to the element
  | 'ambiguous'       // the element could not be re-identified with enough confidence; nothing edited
  | 'no-code-refs'    // nothing in the project uses this element's locators on this platform
  | 'blocked'         // only shared references are broken and shared edits are not allowed
  | 'dry-run'         // a patch was computed but not written
  | 'verified'        // patch applied, build passed, affected tests passed on every platform that needed it
  | 'partial'         // as verified, but other broken references could not be patched and need manual work
  | 'unverified'      // patch applied, but build or tests could not run (missing tool/device/tests)
  | 'rolled-back';    // patch applied, then reverted because build/tests failed or on request

export interface RefAssessment {
  file: string;
  line: number;
  platform: CodeRef['platform'];
  strategy: string;
  value: string;
  field: string | null;
  matches: number | null;
  state: 'ok' | 'missing' | 'ambiguous' | 'wrong-element' | 'unevaluable';
  action: 'none' | 'patched' | 'blocked' | 'not-expressible';
  newLocator: { strategy: LocatorStrategy; value: string } | null;
  note: string | null;
}

export interface FileChange {
  file: string;
  beforeHash: string;
  afterHash: string;
  backup: string;
}

export interface RepairRecord {
  id: string;
  createdAt: string;
  projectRoot: string;
  platform: Platform;
  elementId: string;
  elementName: string;
  screen: string;
  hierarchySource: ElementSnapshot['source'];
  status: RepairStatus;
  message: string;
  match: (MatchCandidate & { margin: number; changes: FingerprintChange[] }) | null;
  runnerUp: MatchCandidate | null;
  refs: RefAssessment[];
  files: FileChange[];
  diff: string;
  platformsValidated: Platform[];
  affectedTests: string[];
  build: StepResult | null;
  tests: Partial<Record<Platform, StepResult>>;
  rollback: { available: boolean; performedAt: string | null; reason: string | null; conflicts: string[] };
}

export interface RepairRequest {
  projectRoot: string;
  platform: Platform;
  elementId: string;
  tree: UiTree;
  hierarchySource: ElementSnapshot['source'];
  screenshot?: string | null;
  device?: ElementSnapshot['device'];
  appId?: string | null;
  /** Live match counter for locators that cannot be evaluated offline. */
  countLive?: (strategy: LocatorStrategy, value: string) => Promise<number>;
  dryRun?: boolean;
  skipTests?: boolean;
  /** Allow editing references that are shared by both platforms; both platforms are then validated. */
  allowSharedEdits?: boolean;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function repairsDir(root: string) {
  return path.join(root, '.elementiq', 'repairs');
}

export class Healer {
  private repo: ElementRepository;

  constructor(repo: ElementRepository) {
    this.repo = repo;
  }

  async repair(req: RepairRequest): Promise<RepairRecord> {
    const { platform, tree } = req;
    if (tree.platform !== platform) throw new InspectorError('WRONG_PLATFORM_BINARY', `A ${tree.platform} hierarchy cannot be used to repair ${platform} code.`, { platform });
    const element = this.repo.get(req.elementId);
    const binding = element.platforms[platform];
    if (!binding) {
      throw new InspectorError('INVALID_INPUT', `"${element.name}" has no ${platform} binding. Record it on ${platform} first; locators are never borrowed from the other platform.`, { platform });
    }
    const root = path.resolve(req.projectRoot);
    const config = loadConfig(root);
    const record: RepairRecord = {
      id: `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(), projectRoot: root, platform, elementId: element.id, elementName: element.name,
      screen: binding.screen, hierarchySource: req.hierarchySource, status: 'not-broken', message: '',
      match: null, runnerUp: null, refs: [], files: [], diff: '', platformsValidated: [], affectedTests: [],
      build: null, tests: {}, rollback: { available: false, performedAt: null, reason: null, conflicts: [] },
    };

    // 1-3. Identify the element on the current screen and find the code that references it.
    const [best, second] = rankMatches(tree, binding.fingerprint, 2);
    const confident = !!best && best.score >= MIN_SCORE && best.score - (second?.score ?? 0) >= MIN_MARGIN;
    if (best) {
      const node = tree.nodes.get(best.nodeId)!;
      record.match = { ...best, margin: Math.round((best.score - (second?.score ?? 0)) * 1000) / 1000, changes: compareFingerprints(binding.fingerprint, fingerprint(tree, node)) };
      record.runnerUp = second ?? null;
    }
    const known = [...binding.locators, ...binding.history.flatMap((h) => h.locators)];
    const { project, refs: allRefs } = scanProject(root);
    const refs = allRefs.filter((r) => (r.platform === platform || r.platform === 'shared') && known.some((l) => refMatchesLocator(r, platform, l)));
    if (!refs.length && config.repositoryDir) {
      return this.repairRepository(record, req, project, config, best, confident);
    }
    if (!refs.length) {
      record.status = 'no-code-refs';
      record.message = `No ${platform} or shared code in ${root} uses a recorded locator of "${element.name}".`;
      return this.save(record);
    }

    const pairs: [CodeRef, RefAssessment][] = [];
    for (const ref of refs) {
      let hits = evaluateOffline(tree, ref.strategy, ref.value);
      let count: number | null = hits ? hits.length : null;
      if (count === null && req.countLive) count = await req.countLive(ref.strategy as LocatorStrategy, ref.value).catch(() => null);
      let state: RefAssessment['state'];
      if (count === null) state = 'unevaluable';
      else if (count === 0) state = 'missing';
      else if (count > 1) state = 'ambiguous';
      else state = confident && hits && hits[0].id !== best.nodeId ? 'wrong-element' : 'ok';
      const assessment: RefAssessment = {
        file: path.relative(root, ref.file), line: ref.line, platform: ref.platform, strategy: ref.strategy, value: ref.value, field: ref.field,
        matches: count, state, action: 'none', newLocator: null,
        note: state === 'unevaluable' ? 'This locator cannot be evaluated offline; repair with a live session to validate it.' : null,
      };
      record.refs.push(assessment);
      pairs.push([ref, assessment]);
    }
    const broken = pairs.filter(([, a]) => a.state === 'missing' || a.state === 'ambiguous' || a.state === 'wrong-element');
    if (!broken.length) {
      record.status = 'not-broken';
      record.message = record.refs.some((r) => r.state === 'unevaluable')
        ? 'No reference is provably broken; some could not be evaluated offline.'
        : `All ${record.refs.length} reference(s) still resolve uniquely to "${element.name}".`;
      return this.save(record);
    }
    if (!confident) {
      record.status = 'ambiguous';
      record.message = best
        ? `Best match ${best.summary} scored ${best.score} (runner-up ${second?.score ?? 0}); below the ${MIN_SCORE} score / ${MIN_MARGIN} margin needed for an automatic repair. Review the candidates manually.`
        : 'The current hierarchy has no candidate elements.';
      return this.save(record);
    }

    // 4. Propose platform-appropriate replacements.
    const node = tree.nodes.get(best.nodeId)!;
    const candidates = generateLocators(tree, node).filter((c) => c.unique);
    const editsByFile = new Map<string, Edit[]>();
    const sources = new Map<string, string>();
    for (const [ref, assessment] of broken) {
      if (ref.platform === 'shared' && !req.allowSharedEdits) {
        assessment.action = 'blocked';
        assessment.note = `Shared by Android and iOS. Changing it to the new ${platform} value could break the other platform; split it into platform-specific locators or re-run with allowSharedEdits to validate both platforms.`;
        continue;
      }
      const src = sources.get(ref.file) ?? readFileSync(ref.file, 'utf8');
      sources.set(ref.file, src);
      const pool = ref.platform === 'shared' ? candidates.filter((c) => CROSS_PLATFORM_STRATEGIES.includes(c.strategy)) : candidates;
      let chosen: { cand: LocatorCandidate; edits: Edit[] } | null = null;
      for (const cand of preferenceOrder(pool, ref)) {
        const edits = renderEdits(src, ref, cand.strategy, cand.value);
        if (edits) {
          chosen = { cand, edits };
          break;
        }
      }
      if (!chosen) {
        assessment.action = 'not-expressible';
        assessment.note = 'No unique locator for the matched element can be expressed in this code syntax.';
        continue;
      }
      assessment.action = 'patched';
      assessment.newLocator = { strategy: chosen.cand.strategy, value: chosen.cand.value };
      const list = editsByFile.get(ref.file) ?? [];
      for (const e of chosen.edits) {
        if (!list.some((x) => x.start === e.start && x.end === e.end && x.text === e.text)) list.push(e);
      }
      editsByFile.set(ref.file, list);
    }
    if (!editsByFile.size) {
      record.status = 'blocked';
      record.message = 'Broken references were found, but none could be patched automatically. See the per-reference notes.';
      return this.save(record);
    }

    // 5. Patch only the affected files; back up originals.
    const backupRoot = path.join(repairsDir(root), record.id, 'before');
    const patched = new Map<string, string>();
    const diffs: string[] = [];
    for (const [file, edits] of editsByFile) {
      const before = sources.get(file)!;
      const after = applyEdits(before, edits);
      patched.set(file, after);
      const rel = path.relative(root, file).replace(/\\/g, '/');
      diffs.push(unifiedDiff(before, after, `a/${rel}`, `b/${rel}`));
      record.files.push({ file: rel, beforeHash: sha(before), afterHash: sha(after), backup: path.join('before', rel) });
    }
    record.diff = diffs.join('');
    if (req.dryRun) {
      record.status = 'dry-run';
      record.message = `Proposed changes to ${record.files.length} file(s); nothing was written.`;
      return this.save(record);
    }
    for (const [file, after] of patched) {
      const backup = path.join(backupRoot, path.relative(root, file));
      mkdirSync(path.dirname(backup), { recursive: true });
      writeFileSync(backup, sources.get(file)!);
      writeFileSync(file, after);
    }
    record.rollback.available = true;

    const owners = [...new Set(refs.filter((r) => editsByFile.has(r.file)).map((r) => r.owner).filter((o): o is string => !!o))];
    const failed = await this.verify(record, req, project, config, [...patched.keys()], owners);
    if (failed) return failed;
    const { element: updated } = this.repo.capture({
      platform, tree, node, name: element.name, screen: binding.screen, elementId: element.id,
      device: req.device ?? null, appId: req.appId ?? null, screenshotBase64: req.screenshot ?? null, source: req.hierarchySource,
    });
    this.repo.setCodeRefs(updated.id, platform, pairs.filter(([, a]) => a.action === 'patched' || a.state === 'ok').map(([ref, a]) => ({
      file: a.file, line: a.line, field: a.field, owner: ref.owner, strategy: a.newLocator?.strategy ?? ref.strategy, value: a.newLocator?.value ?? ref.value, syntax: ref.syntax,
    })));
    return this.save(record);
  }

  /** Steps 6-8 shared by code and repository repairs. Returns the saved record when the change was rolled back. */
  private async verify(
    record: RepairRecord, req: RepairRequest, project: ProjectInfo, config: ProjectConfig, changedFiles: string[], owners: string[],
  ): Promise<RepairRecord | null> {
    // 6. Compile / type-check.
    const sharedEdited = record.refs.some((r) => r.action === 'patched' && r.platform === 'shared');
    record.platformsValidated = sharedEdited ? ['android', 'ios'] : [record.platform];
    record.build = await buildCheck(project, changedFiles, config);
    const rollbackOnFailure = config.rollbackOnFailure ?? true;
    if (record.build.status === 'failed') {
      return this.finishFailed(record, record.projectRoot, rollbackOnFailure, 'Build/type-check failed after the patch.');
    }

    // 7. Run affected tests on every platform the change can affect.
    const affected = findAffectedTests(project, owners);
    record.affectedTests = affected.map((f) => path.relative(record.projectRoot, f).replace(/\\/g, '/'));
    for (const p of record.platformsValidated) {
      record.tests[p] = req.skipTests
        ? { status: 'skipped', reason: 'Tests were skipped by request.', command: null, exitCode: null, durationMs: 0, output: '' }
        : await runAffectedTests(project, affected, p, config);
      if (record.tests[p]!.status === 'failed') {
        return this.finishFailed(record, record.projectRoot, rollbackOnFailure, `Affected ${p} tests failed after the patch.`);
      }
    }

    // 8. Record outcome and keep the repository in step with the code.
    const allPassed = record.build.status === 'passed' && record.platformsValidated.every((p) => record.tests[p]?.status === 'passed');
    const leftover = record.refs.filter((r) => r.action === 'blocked' || r.action === 'not-expressible').length;
    record.status = !allPassed ? 'unverified' : leftover ? 'partial' : 'verified';
    const gaps = [
      record.build.status !== 'passed' ? `build: ${record.build.reason}` : null,
      ...record.platformsValidated.filter((p) => record.tests[p]?.status !== 'passed').map((p) => `${p} tests: ${record.tests[p]?.reason}`),
    ].filter(Boolean);
    record.message = allPassed
      ? `Patched ${record.files.length} file(s); build and affected ${record.platformsValidated.join(' + ')} tests passed.`
      : `Patched ${record.files.length} file(s) but the change is NOT verified (${gaps.join('; ')}). Review the diff, or roll back.`;
    if (leftover) record.message += ` ${leftover} broken reference(s) still need manual attention.`;
    return null;
  }

  /**
   * Repair for projects whose framework reads locators from an ElementIQ repository.json (config.repositoryDir).
   * The project's repository binding is the "code" being fixed: same matching, backup, diff, build, tests and rollback.
   */
  private async repairRepository(
    record: RepairRecord, req: RepairRequest, project: ProjectInfo, config: ProjectConfig, best: MatchCandidate | undefined, confident: boolean,
  ): Promise<RepairRecord> {
    const root = record.projectRoot;
    const { platform, tree } = req;
    const dir = path.resolve(root, config.repositoryDir!);
    const file = path.join(dir, 'repository.json');
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (!existsSync(file)) {
      record.status = 'no-code-refs';
      record.message = `repositoryDir points to ${rel}, which does not exist.`;
      return this.save(record);
    }
    const sameRepo = path.resolve(this.repo.dir) === dir;
    const projectRepo = sameRepo ? this.repo : new ElementRepository(dir);
    const target = projectRepo.findByName(record.elementName);
    const tb = target?.platforms[platform];
    if (!target || !tb) {
      record.status = 'no-code-refs';
      record.message = `${rel} has no ${platform} binding for "${record.elementName}".`;
      return this.save(record);
    }
    const primary = tb.locators.find((l) => l.unique) ?? tb.locators[0];
    const hits = evaluateOffline(tree, primary.strategy, primary.value);
    let count: number | null = hits ? hits.length : null;
    if (count === null && req.countLive) count = await req.countLive(primary.strategy, primary.value).catch(() => null);
    const state: RefAssessment['state'] = count === null ? 'unevaluable' : count === 0 ? 'missing' : count > 1 ? 'ambiguous'
      : confident && hits && best && hits[0].id !== best.nodeId ? 'wrong-element' : 'ok';
    const before = readFileSync(file, 'utf8');
    const assessment: RefAssessment = {
      file: rel, line: before.split('\n').findIndex((l) => l.includes(`"name": ${JSON.stringify(record.elementName)}`)) + 1,
      platform, strategy: primary.strategy, value: primary.value, field: record.elementName, matches: count, state,
      action: 'none', newLocator: null, note: 'The test framework reads this locator from the ElementIQ repository.',
    };
    record.refs.push(assessment);
    if (state === 'ok' || state === 'unevaluable') {
      record.status = 'not-broken';
      record.message = state === 'ok'
        ? `The repository locator still resolves uniquely to "${record.elementName}".`
        : 'The repository locator could not be evaluated offline; use a live session.';
      return this.save(record);
    }
    if (!confident || !best) {
      record.status = 'ambiguous';
      record.message = best
        ? `Best match ${best.summary} scored ${best.score}; below the ${MIN_SCORE} score / ${MIN_MARGIN} margin needed for an automatic repair.`
        : 'The current hierarchy has no candidate elements.';
      return this.save(record);
    }
    const node = tree.nodes.get(best.nodeId)!;
    const chosen = bestLocator(generateLocators(tree, node));
    if (!chosen) {
      assessment.action = 'not-expressible';
      record.status = 'blocked';
      record.message = `${best.summary} has no unique locator on this screen.`;
      return this.save(record);
    }
    assessment.action = 'patched';
    assessment.newLocator = { strategy: chosen.strategy, value: chosen.value };
    if (req.dryRun) {
      record.status = 'dry-run';
      record.message = `Would change ${record.elementName} [${platform}] in ${rel} to ${chosen.strategy}="${chosen.value}"; nothing was written.`;
      return this.save(record);
    }
    const backupRel = path.join('before', path.relative(root, file));
    const backup = path.join(repairsDir(root), record.id, backupRel);
    mkdirSync(path.dirname(backup), { recursive: true });
    writeFileSync(backup, before);
    projectRepo.capture({
      platform, tree, node, name: record.elementName, screen: tb.screen, elementId: target.id,
      device: req.device ?? null, appId: req.appId ?? null, screenshotBase64: null, source: req.hierarchySource,
    });
    const after = readFileSync(file, 'utf8');
    record.files.push({ file: rel, beforeHash: sha(before), afterHash: sha(after), backup: backupRel });
    record.diff = unifiedDiff(before, after, `a/${rel}`, `b/${rel}`);
    record.rollback.available = true;

    // Screens/steps that use this logical element decide which tests are affected.
    const quoted = [`"${record.elementName}"`, `'${record.elementName}'`];
    const owners = project.sourceFiles
      .filter((f) => !project.testFiles.includes(f) && quoted.some((q) => readFileSync(f, 'utf8').includes(q)))
      .map((f) => path.basename(f).replace(/\.[^.]+$/, ''));
    const failed = await this.verify(record, req, project, config, [file], owners);
    if (failed) return failed;
    if (!sameRepo) {
      this.repo.capture({
        platform, tree, node, name: record.elementName, screen: tb.screen, elementId: record.elementId,
        device: req.device ?? null, appId: req.appId ?? null, screenshotBase64: req.screenshot ?? null, source: req.hierarchySource,
      });
    }
    return this.save(record);
  }

  private finishFailed(record: RepairRecord, root: string, rollback: boolean, reason: string): RepairRecord {
    if (rollback) {
      this.restore(record, root, `${reason} Automatic rollback.`, false);
      record.status = 'rolled-back';
      record.message = `${reason} The change was rolled back automatically.`;
    } else {
      record.status = 'unverified';
      record.message = `${reason} rollbackOnFailure is disabled, so the change was left in place.`;
    }
    return this.save(record);
  }

  private restore(record: RepairRecord, root: string, reason: string, force: boolean) {
    const dir = path.join(repairsDir(root), record.id);
    const conflicts: string[] = [];
    for (const f of record.files) {
      const target = path.join(root, f.file);
      const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
      if (!force && current !== null && sha(current) !== f.afterHash) {
        conflicts.push(`${f.file} was modified after the repair; not restored (use force to overwrite).`);
        continue;
      }
      writeFileSync(target, readFileSync(path.join(dir, f.backup), 'utf8'));
      if (path.resolve(target) === path.resolve(this.repo.dir, 'repository.json')) this.repo.reload();
    }
    record.rollback = { available: conflicts.length > 0, performedAt: new Date().toISOString(), reason, conflicts };
  }

  rollback(projectRoot: string, id: string, force = false): RepairRecord {
    const root = path.resolve(projectRoot);
    const record = this.load(root, id);
    if (!record.files.length || (record.rollback.performedAt && !record.rollback.conflicts.length)) {
      throw new InspectorError('INVALID_INPUT', `Repair ${id} has nothing to roll back (status ${record.status}).`);
    }
    this.restore(record, root, 'Rolled back on request.', force);
    if (!record.rollback.conflicts.length) record.status = 'rolled-back';
    return this.save(record);
  }

  load(projectRoot: string, id: string): RepairRecord {
    if (!/^[\w-]+$/.test(id)) throw new InspectorError('INVALID_INPUT', 'Invalid repair id.');
    const file = path.join(repairsDir(path.resolve(projectRoot)), id, 'record.json');
    if (!existsSync(file)) throw new InspectorError('INVALID_INPUT', `Repair ${id} not found in ${projectRoot}.`);
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  list(projectRoot: string): RepairRecord[] {
    const dir = repairsDir(path.resolve(projectRoot));
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((d) => existsSync(path.join(dir, d, 'record.json')))
      .map((d) => JSON.parse(readFileSync(path.join(dir, d, 'record.json'), 'utf8')) as RepairRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private save(record: RepairRecord): RepairRecord {
    const dir = path.join(repairsDir(record.projectRoot), record.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'record.json'), JSON.stringify(record, null, 2));
    if (record.diff) writeFileSync(path.join(dir, 'diff.patch'), record.diff);
    return record;
  }
}

/** Same strategy as the code already uses comes first (smallest diff), unless that was XPath. */
function preferenceOrder(cands: LocatorCandidate[], ref: CodeRef): LocatorCandidate[] {
  const nonAbsolute = cands.filter((c) => c.criteria.nodeId === undefined);
  const pool = nonAbsolute.length ? nonAbsolute : cands;
  if (ref.strategy === 'xpath') return pool;
  const same = pool.filter((c) => c.strategy === ref.strategy || (ref.platform === 'ios' && ref.strategy === 'id' && c.strategy === 'accessibility id'));
  return [...same, ...pool.filter((c) => !same.includes(c))];
}
