'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  platform: 'android',
  sessions: [],
  activeId: null,
  snapshots: {},     // sessionId -> snapshot
  nodeIndex: {},     // sessionId -> Map(nodeId -> node)
  selected: null,
  repo: { elements: [], tests: [] },
};

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok || json?.error) throw json.error ?? { message: res.statusText };
  return json;
}

function toast(err, info = false) {
  $('#toast')?.remove();
  const t = document.createElement('div');
  t.id = 'toast';
  if (info) t.className = 'info';
  t.innerHTML = info ? esc(err) : `<b>${esc(err.code ?? 'Error')}</b> ${esc(err.message)}${err.hint ? `<br><small>${esc(err.hint)}</small>` : ''}`;
  document.body.append(t);
  setTimeout(() => t.remove(), info ? 3000 : 9000);
}

const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e); } };

// ---- platform & health ----------------------------------------------------------------------------

function setPlatform(p) {
  state.platform = p;
  document.body.dataset.platform = p;
  $$('#platformSeg button').forEach((b) => b.classList.toggle('on', b.dataset.platform === p));
  $('#devices').innerHTML = '';
  $('#issues').innerHTML = '';
  renderTabs();
}

async function health() {
  try {
    const h = await api('GET', `/api/health?appiumUrl=${encodeURIComponent($('#appiumUrl').value)}`);
    const el = $('#health');
    const ok = h.appium.server.reachable;
    el.className = 'badge ' + (ok ? 'ok' : 'err');
    el.textContent = ok ? `Appium ${h.appium.server.version ?? ''} reachable` : 'Appium not reachable';
    el.title = JSON.stringify(h, null, 2);
  } catch (e) { toast(e); }
}

// ---- devices & sessions ---------------------------------------------------------------------------

function renderIssues(target, issues) {
  target.innerHTML = issues.map((i) => `<div class="issue ${/NOT_FOUND|REQUIRES|UNAUTHORIZED/.test(i.code) ? 'err' : ''}"><b>${esc(i.code)}</b>${esc(i.message)}${i.hint ? `<div class="muted">${esc(i.hint)}</div>` : ''}</div>`).join('');
}

const discover = guard(async () => {
  $('#devices').innerHTML = '<li class="muted">Discovering…</li>';
  const d = await api('GET', `/api/devices?platform=${state.platform}`);
  renderIssues($('#issues'), d.issues);
  $('#devices').innerHTML = d.devices.length
    ? d.devices.map((x, i) => `<li class="clickable" data-i="${i}"><span class="tag ${x.platform}">${esc(x.kind)}</span> <b>${esc(x.name)}</b> <span class="muted">${esc(x.osVersion)} · ${esc(x.state)}</span><br><small class="muted">${esc(x.udid)}</small>${x.notes.map((n) => `<div class="issue">${esc(n)}</div>`).join('')}</li>`).join('')
    : '<li class="muted">No devices found. See the issues above; you can still enter a UDID manually.</li>';
  $$('#devices li[data-i]').forEach((li) => li.addEventListener('click', () => {
    const dev = d.devices[li.dataset.i];
    const f = $('#connectForm');
    f.udid.value = dev.udid;
    f.deviceKind.value = dev.kind;
  }));
});

const connect = guard(async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const v = (n) => f[n]?.value?.trim() || undefined;
  const body = {
    platform: state.platform, udid: v('udid'), deviceKind: v('deviceKind'), appId: v('appId'), app: v('app'),
    appActivity: state.platform === 'android' ? v('appActivity') : undefined, appiumUrl: $('#appiumUrl').value,
  };
  if (state.platform === 'ios') {
    body.ios = { xcodeOrgId: v('xcodeOrgId'), xcodeSigningId: v('xcodeSigningId'), updatedWDABundleId: v('updatedWDABundleId'), webDriverAgentUrl: v('webDriverAgentUrl'), usePrebuiltWDA: f.usePrebuiltWDA.checked };
  }
  toast(`Starting ${state.platform} session… (iOS real devices may take minutes while WDA builds)`, true);
  const s = await api('POST', '/api/sessions', body);
  await refreshSessions(s.id);
});

const loadOffline = guard(async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const source = await f.source.files[0].text();
  let screenshot = null;
  if (f.shot.files[0]) {
    const buf = new Uint8Array(await f.shot.files[0].arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    screenshot = btoa(bin);
  }
  const s = await api('POST', '/api/sessions/offline', { platform: state.platform, source, screenshot, label: f.source.files[0].name });
  await refreshSessions(s.id);
});

async function refreshSessions(activate) {
  state.sessions = await api('GET', '/api/sessions');
  if (activate) state.activeId = activate;
  if (!state.sessions.some((s) => s.id === state.activeId)) state.activeId = null;
  renderTabs();
  if (activate) await snapshot();
}

function renderTabs() {
  $('#sessionTabs').innerHTML = state.sessions.map((s) => `
    <button data-id="${s.id}" class="${s.id === state.activeId ? 'on' : ''}">
      <span class="tag ${s.mode === 'offline' ? 'offline' : s.platform}">${s.platform}</span> ${esc(s.deviceLabel)}${s.recording ? ' ●' : ''}
      <span data-close="${s.id}" title="Close session">✕</span>
    </button>`).join('') || '<span class="muted">No sessions. Android and iOS sessions run independently; open one per device.</span>';
  $$('#sessionTabs button').forEach((b) => b.addEventListener('click', guard(async (e) => {
    if (e.target.dataset.close) {
      await api('DELETE', `/api/sessions/${e.target.dataset.close}`);
      delete state.snapshots[e.target.dataset.close];
      await refreshSessions();
      renderScreen();
      return;
    }
    state.activeId = b.dataset.id;
    const s = active();
    if (s && s.platform !== state.platform) setPlatform(s.platform);
    renderTabs();
    state.snapshots[b.dataset.id] ? renderAll() : await snapshot();
  })));
}

const active = () => state.sessions.find((s) => s.id === state.activeId);

const snapshot = guard(async () => {
  if (!state.activeId) return;
  const snap = await api('GET', `/api/sessions/${state.activeId}/snapshot`);
  state.snapshots[state.activeId] = snap;
  const idx = new Map();
  const walk = (n) => { idx.set(n.id, n); n.children.forEach(walk); };
  if (snap.tree) walk(snap.tree);
  state.nodeIndex[state.activeId] = idx;
  state.selected = null;
  renderAll();
});

function renderAll() {
  const s = active();
  const snap = state.snapshots[state.activeId];
  $('#sessionInfo').textContent = s ? `${s.platform} · ${s.deviceLabel}${s.osVersion ? ' · ' + s.osVersion : ''}${s.appId ? ' · ' + s.appId : ''} · ${s.mode}` : '';
  $('#contextSel').innerHTML = (snap?.contexts ?? []).map((c) => `<option ${c === snap.context ? 'selected' : ''}>${esc(c)}</option>`).join('');
  $('#notices').innerHTML = (snap?.notices ?? []).map((n) => `<div class="issue">${esc(n)}</div>`).join('');
  $('#recBtn').textContent = s?.recording ? 'Stop recording' : 'Start recording';
  renderScreen();
  renderTree();
  renderSelection();
}

// ---- screenshot & hierarchy -----------------------------------------------------------------------

/** Width of the largest node, in the same units as bounds (pixels on Android, points on iOS). */
function screenWidth() {
  let w = 0;
  for (const n of state.nodeIndex[state.activeId].values()) if (n.bounds && n.bounds.width > w) w = n.bounds.width;
  return w || 1;
}

function renderScreen() {
  const snap = state.snapshots[state.activeId];
  const el = $('#screen');
  if (!snap) { el.innerHTML = '<p class="muted">Connect a device or load a snapshot.</p>'; return; }
  if (!snap.screenshot) { el.innerHTML = '<p class="muted">No screenshot available for this snapshot. Use the hierarchy to select elements.</p>'; return; }
  el.innerHTML = `<img id="shot" alt="Device screenshot" src="data:image/png;base64,${snap.screenshot}"><div id="box" class="box" hidden></div>`;
  const img = $('#shot');
  img.addEventListener('load', drawBox);
  img.addEventListener('click', (e) => {
    if (!snap.tree) return;
    const r = img.getBoundingClientRect();
    const scale = screenWidth() / r.width;
    const x = (e.clientX - r.left) * scale;
    const y = (e.clientY - r.top) * scale;
    let best = null;
    for (const n of state.nodeIndex[state.activeId].values()) {
      const b = n.bounds;
      if (b && x >= b.x && y >= b.y && x <= b.x + b.width && y <= b.y + b.height && (!best || b.width * b.height <= best.bounds.width * best.bounds.height)) best = n;
    }
    if (best) select(best.id);
  });
}

function drawBox() {
  const box = $('#box');
  const img = $('#shot');
  const node = state.selected && state.nodeIndex[state.activeId]?.get(state.selected);
  if (!box || !img || !node?.bounds) { if (box) box.hidden = true; return; }
  const k = img.clientWidth / screenWidth();
  Object.assign(box.style, { left: node.bounds.x * k + 'px', top: node.bounds.y * k + 'px', width: node.bounds.width * k + 'px', height: node.bounds.height * k + 'px' });
  box.hidden = false;
}

function label(n) {
  const a = n.attrs;
  const key = state.platform === 'android' ? (a['resource-id'] || a['content-desc'] || a.text) : (a.name || a.label || a.value);
  return `${esc(n.tag.replace(/^android\.widget\.|^XCUIElementType/, ''))}${key ? ` <span class="muted">${esc(key)}</span>` : ''}`;
}

function renderTree() {
  const snap = state.snapshots[state.activeId];
  const el = $('#tree');
  if (!snap?.tree) { el.innerHTML = snap?.webSource ? '<p class="muted">WebView context: HTML source; switch to NATIVE_APP for native inspection.</p>' : ''; return; }
  const html = (n) => n.children.length
    ? `<details open><summary data-id="${n.id}">${label(n)}</summary>${n.children.map(html).join('')}</details>`
    : `<div class="leaf" data-id="${n.id}">${label(n)}</div>`;
  el.innerHTML = html(snap.tree);
  el.onclick = (e) => {
    const id = e.target.closest('[data-id]')?.dataset.id;
    if (id && e.target.closest('.leaf, summary')) { if (e.target.closest('summary')) e.preventDefault(); select(id); }
  };
}

const select = guard(async (id) => {
  state.selected = id;
  $$('#tree .sel').forEach((x) => x.classList.remove('sel'));
  const row = $(`#tree [data-id="${CSS.escape(id)}"]`);
  row?.classList.add('sel');
  row?.scrollIntoView({ block: 'nearest' });
  drawBox();
  renderSelection();
  const r = await api('GET', `/api/sessions/${state.activeId}/locators?nodeId=${encodeURIComponent(id)}`);
  $('#locators').innerHTML = (r.issues.length ? r.issues.map((i) => `<div class="issue err">${esc(i)}</div>`).join('') : '') + r.candidates.map((c) => `
    <div class="loc ${c.unique ? '' : 'bad'}">
      <div><b>${esc(c.strategy)}</b> <span class="muted">rank ${c.rank} · score ${c.score} · snapshot ${c.snapshotMatches}${c.liveMatches === null ? '' : ' · device ' + c.liveMatches} match(es)</span>${c.unique ? ' ✓' : ''}</div>
      <code>${esc(c.value)}</code> <button data-copy="${esc(c.value)}">copy</button>
      <div class="muted">${esc(c.reason)}</div>
      ${c.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}
    </div>`).join('');
  $$('#locators [data-copy]').forEach((b) => b.addEventListener('click', () => navigator.clipboard.writeText(b.dataset.copy)));
});

function renderSelection() {
  const node = state.selected && state.nodeIndex[state.activeId]?.get(state.selected);
  if (!node) { $('#props').innerHTML = '<p class="muted">Select an element on the screenshot or in the hierarchy.</p>'; $('#locators').innerHTML = ''; return; }
  $('#props').innerHTML = `<table class="props">${Object.entries(node.attrs).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
}

// ---- actions & recording --------------------------------------------------------------------------

const act = guard(async (e) => {
  const action = e.target.dataset.act;
  if (!action) return;
  if (action !== 'back' && !state.selected) throw { message: 'Select an element first.' };
  await api('POST', `/api/sessions/${state.activeId}/actions`, { action, nodeId: action === 'back' ? undefined : state.selected, value: $('#typeText').value });
  await refreshRecording();
  await snapshot();
});

async function refreshRecording() {
  if (!state.activeId) return;
  const r = await api('GET', `/api/sessions/${state.activeId}/recording`);
  $('#recList').innerHTML = r.actions.map((a) => `<li><span class="tag ${a.platform}">${a.platform}</span> <b>${esc(a.action)}</b> ${esc(a.value ?? '')} ${a.locator ? `<code>${esc(a.locator.strategy)}=${esc(a.locator.value)}</code>` : ''} <span class="muted">${esc(a.nodeSummary ?? '')} · ${a.alternatives.length} alternative(s)</span></li>`).join('') || '<li class="muted">No recorded actions.</li>';
}

const toggleRecording = guard(async () => {
  const s = active();
  if (!s) return;
  await api('POST', `/api/sessions/${s.id}/recording`, { on: !s.recording });
  await refreshSessions();
  renderAll();
  await refreshRecording();
});

const playback = guard(async () => {
  const steps = await api('POST', `/api/sessions/${state.activeId}/playback`, {});
  $('#playResult').innerHTML = `<table>${steps.map((s) => `<tr><td>${s.index + 1}</td><td>${esc(s.action)}</td><td class="status ${s.status === 'failed' ? 'rolled-back' : 'verified'}">${esc(s.status)}</td><td>${s.usedLocator ? esc(s.usedLocator.strategy + '=' + s.usedLocator.value) : ''}${s.error ? ' ' + esc(s.error.message) : ''}</td></tr>`).join('')}</table>`;
});

// ---- repository -----------------------------------------------------------------------------------

const capture = guard(async (ev) => {
  ev.preventDefault();
  if (!state.selected) throw { message: 'Select an element first.' };
  const f = ev.target;
  const r = await api('POST', '/api/repository/capture', { sessionId: state.activeId, nodeId: state.selected, name: f.name.value, screen: f.screen.value, purpose: f.purpose.value, elementId: f.elementId.value });
  toast(r.changes.length ? `Captured. Changed since last ${state.platform} capture: ${r.changes.map((c) => c.field).join(', ')}` : 'Captured.', true);
  await loadRepo();
});

function bindingCell(b) {
  if (!b) return '<span class="muted">not recorded</span>';
  const l = b.locators.find((x) => x.unique) ?? b.locators[0];
  return `<code>${esc(l.strategy)}=${esc(l.value)}</code><br><small class="muted">${esc(b.screen)} · ${b.history.length} capture(s) · ${b.codeRefs.length} code ref(s)</small>`;
}

async function loadRepo() {
  state.repo = await api('GET', '/api/repository');
  const els = state.repo.elements;
  $('#repoTable tbody').innerHTML = els.map((e) => `<tr>
    <td><b>${esc(e.name)}</b></td><td>${esc(e.purpose)}</td><td>${bindingCell(e.platforms.android)}</td><td>${bindingCell(e.platforms.ios)}</td>
    <td>${['android', 'ios'].filter((p) => e.platforms[p]).map((p) => `<button data-hist="${e.id}" data-p="${p}">${p} history</button>`).join(' ')} <button data-del="${e.id}">delete</button></td></tr>`).join('');
  const opts = '<option value="">— choose element —</option>' + els.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
  $('#captureForm select[name=elementId]').innerHTML = '<option value="">— new / match by name —</option>' + els.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
  $('#repairForm select[name=elementId]').innerHTML = opts;
}

const repoClick = guard(async (e) => {
  if (e.target.dataset.del && confirm('Delete this logical element (both platforms)?')) {
    await api('DELETE', `/api/repository/elements/${e.target.dataset.del}`);
    await loadRepo();
  }
  if (e.target.dataset.hist) {
    const h = await api('GET', `/api/repository/elements/${e.target.dataset.hist}/history?platform=${e.target.dataset.p}`);
    $('#history').innerHTML = `<h2>${esc(e.target.dataset.p)} history</h2>` + h.map((x) => `
      <div class="loc"><b>${esc(new Date(x.snapshot.capturedAt).toLocaleString())}</b> <span class="muted">${esc(x.snapshot.source)}${x.snapshot.device ? ' · ' + esc(x.snapshot.device.model) : ''}</span>
      ${x.snapshot.screenshot ? `<a href="/api/repository/screenshots/${x.snapshot.screenshot}" target="_blank">screenshot</a>` : ''}
      ${x.changesFromPrevious.map((c) => `<div class="warn">${esc(c.field)}: ${esc(c.before)} → ${esc(c.after)}</div>`).join('')}</div>`).join('');
  }
});

const exportRepo = guard(async () => {
  const bundle = await api('GET', '/api/repository/export');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
  a.download = `elementiq-repository-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});

const importRepo = guard(async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const r = await api('POST', '/api/repository/import', { bundle: JSON.parse(await file.text()), mode: $('#importMode').value });
  toast(`Imported ${r.elements} element(s) and ${r.tests} test(s).`, true);
  e.target.value = '';
  await loadRepo();
});

// ---- code mapping & repair ------------------------------------------------------------------------

const refRow = (r) => `<tr><td><span class="tag ${r.platform === 'ios' || r.platform === 'android' ? r.platform : 'offline'}">${esc(r.platform)}</span></td><td>${esc(r.file)}:${r.line}</td><td>${esc(r.owner ?? '')}.${esc(r.field ?? '?')}</td><td><code>${esc(r.strategy)}=${esc(r.value)}</code></td></tr>`;

const scan = guard(async (ev) => {
  ev.preventDefault();
  const r = await api('POST', '/api/project/scan', { root: $('#projectRoot').value });
  localStorage.setItem('elementiq.root', $('#projectRoot').value);
  const p = r.project;
  $('#scanResult').innerHTML = `
    <p><b>${esc(p.buildSystem)}</b> · ${esc(p.languages.join(', '))} · ${esc(p.frameworks.join(', ') || 'no known framework')} · ${p.sourceFiles} source file(s) · ${p.testFiles.length} test file(s) · ${p.pageObjects.length} page/screen object(s)</p>
    <h2>Mapped to repository</h2>
    <table>${r.mappings.map((m) => `<tr><td><b>${esc(m.name)}</b> <span class="tag ${m.platform}">${m.platform}</span></td><td>${m.refs.length ? `<table>${m.refs.map(refRow).join('')}</table>` : '<span class="muted">no code reference found</span>'}</td></tr>`).join('')}</table>
    <h2>Locators in code not yet in the repository (${r.unmapped.length})</h2>
    <table>${r.unmapped.map(refRow).join('')}</table>`;
  await loadRepo();
});

function renderRepair(r) {
  const diff = r.diff ? `<pre class="diff">${r.diff.split('\n').map((l) => `<span class="${l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : ''}">${esc(l)}</span>`).join('\n')}</pre>` : '';
  const step = (name, s) => s ? `<tr><td>${name}</td><td class="status ${s.status === 'passed' ? 'verified' : s.status === 'failed' ? 'rolled-back' : 'unverified'}">${esc(s.status)}</td><td>${esc(s.reason)}${s.summary ? ` (${s.summary.tests} tests, ${s.summary.failures} failures, ${s.summary.errors} errors)` : ''}<br><code>${esc(s.command ?? '')}</code>${s.output ? `<details><summary>output</summary><pre class="diff">${esc(s.output)}</pre></details>` : ''}</td></tr>` : '';
  return `<div class="loc">
    <div><span class="tag ${r.platform}">${r.platform}</span> <b>${esc(r.elementName)}</b> · <span class="status ${r.status}">${esc(r.status)}</span> · <span class="muted">${esc(new Date(r.createdAt).toLocaleString())} · ${esc(r.id)}</span></div>
    <p>${esc(r.message)}</p>
    ${r.match ? `<p class="muted">Matched ${esc(r.match.summary)} (score ${r.match.score}, margin ${r.match.margin}). Changes: ${esc(r.match.changes.map((c) => `${c.field}: ${c.before} → ${c.after}`).join('; ') || 'none')}</p>` : ''}
    <table>${r.refs.map((x) => `<tr><td>${esc(x.file)}:${x.line}</td><td>${esc(x.field ?? '')}</td><td><code>${esc(x.strategy)}=${esc(x.value)}</code></td><td>${esc(x.state)} (${x.matches ?? '?'} match)</td><td>${esc(x.action)}${x.newLocator ? ` → <code>${esc(x.newLocator.strategy)}=${esc(x.newLocator.value)}</code>` : ''}${x.note ? `<div class="warn">${esc(x.note)}</div>` : ''}</td></tr>`).join('')}</table>
    ${diff}
    <table>${step('build', r.build)}${Object.entries(r.tests).map(([p, s]) => step(`${p} tests`, s)).join('')}</table>
    ${r.rollback.available ? `<button data-rollback="${r.id}">Roll back</button>` : ''}
    ${r.rollback.performedAt ? `<p class="muted">Rolled back ${esc(new Date(r.rollback.performedAt).toLocaleString())}: ${esc(r.rollback.reason)}</p>` : ''}
    ${r.rollback.conflicts.map((c) => `<div class="issue err">${esc(c)}</div>`).join('')}
  </div>`;
}

const repair = guard(async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (!state.activeId) throw { message: 'Open a session on the changed screen (live or offline snapshot) first.' };
  if (!$('#projectRoot').value) throw { message: 'Set the project path in the Code mapping tab.' };
  $('#repairResult').innerHTML = '<p class="muted">Repairing: matching element, patching, compiling, running affected tests…</p>';
  const r = await api('POST', '/api/repair', { sessionId: state.activeId, root: $('#projectRoot').value, elementId: f.elementId.value, dryRun: f.dryRun.checked, skipTests: f.skipTests.checked, allowSharedEdits: f.allowSharedEdits.checked });
  $('#repairResult').innerHTML = renderRepair(r);
  await loadRepo();
});

const listRepairs = guard(async () => {
  const list = await api('GET', `/api/repairs?root=${encodeURIComponent($('#projectRoot').value)}`);
  $('#repairResult').innerHTML = list.map(renderRepair).join('') || '<p class="muted">No repairs recorded for this project.</p>';
});

const repairClick = guard(async (e) => {
  const id = e.target.dataset.rollback;
  if (!id || !confirm('Restore the files changed by this repair?')) return;
  let r = await api('POST', `/api/repairs/${id}/rollback`, { root: $('#projectRoot').value });
  if (r.rollback.conflicts.length && confirm(`${r.rollback.conflicts.join('\n')}\n\nOverwrite anyway?`)) {
    r = await api('POST', `/api/repairs/${id}/rollback`, { root: $('#projectRoot').value, force: true });
  }
  $('#repairResult').innerHTML = renderRepair(r);
});

// ---- wiring ---------------------------------------------------------------------------------------

$$('#platformSeg button').forEach((b) => b.addEventListener('click', () => setPlatform(b.dataset.platform)));
$$('#bottomTabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#bottomTabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
}));
$('#discoverBtn').addEventListener('click', discover);
$('#connectForm').addEventListener('submit', connect);
$('#offlineForm').addEventListener('submit', loadOffline);
$('#refreshBtn').addEventListener('click', snapshot);
$('#contextSel').addEventListener('change', guard(async (e) => { await api('POST', `/api/sessions/${state.activeId}/context`, { name: e.target.value }); await snapshot(); }));
$('#actions').addEventListener('click', act);
$('#captureForm').addEventListener('submit', capture);
$('#recBtn').addEventListener('click', toggleRecording);
$('#playBtn').addEventListener('click', playback);
$('#repoTable').addEventListener('click', repoClick);
$('#exportBtn').addEventListener('click', exportRepo);
$('#importFile').addEventListener('change', importRepo);
$('#scanForm').addEventListener('submit', scan);
$('#repairForm').addEventListener('submit', repair);
$('#listRepairsBtn').addEventListener('click', listRepairs);
$('#repairResult').addEventListener('click', repairClick);
$('#appiumUrl').addEventListener('change', health);
window.addEventListener('resize', drawBox);

try { $('#projectRoot').value = localStorage.getItem('elementiq.root') ?? ''; } catch {}
setPlatform('android');
health();
refreshSessions().catch(toast);
loadRepo().catch(toast);
