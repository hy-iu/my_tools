// ---------- utils ----------
const $ = (sel) => document.querySelector(sel);
const state = {
  sessions: [], overview: null, problems: null, knowledge: null, adapters: [],
  daily: [], trace: null, sort: { key: 'last_activity', dir: 'desc' }, dmetric: 'tokens',
};

async function api(path, opts) {
  const res = await fetch('/api/' + path, opts && {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts),
  });
  return res.json();
}

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (v) => esc(v).replace(/"/g, '&quot;');
const fmtTokens = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n ?? 0);
const fmtCost = (n) => { n = Number(n); if (!isFinite(n)) n = 0; return n >= 1 ? '$' + n.toFixed(2) : '$' + n.toFixed(4); };
const sessionTokens = (s) => s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_write_tokens + s.reasoning_tokens;

function parseTs(ts) {
  if (!ts) return null;
  let iso = String(ts).includes('T') ? String(ts) : String(ts).replace(' ', 'T');
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso += 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
const fmtTime = (ts) => {
  const d = parseTs(ts);
  if (!d) return '';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};
const fmtAbs = (ts) => (parseTs(ts) ?? new Date()).toLocaleString();
const projName = (cwd) => (cwd || '?').split('/').filter(Boolean).pop() || cwd || '?';

const PALETTE = ['#58a6ff', '#3fb950', '#d2a8ff', '#d29922', '#ff7b9c', '#79c0ff', '#56d364', '#e3b341'];
function agentColor(agent) {
  let h = 0;
  for (const c of String(agent)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function badge(agent) {
  const c = agentColor(agent);
  return `<span class="badge" style="color:${c};border-color:${c}55;background:${c}14">${esc(agent)}</span>`;
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// ---------- tooltip / toast ----------
// NOTE: tooltip takes HTML — every interpolated dynamic value must be esc()'d.
const tooltip = $('#tooltip');
function showTip(html, ev) {
  tooltip.innerHTML = html;
  tooltip.classList.remove('hidden');
  moveTip(ev);
}
function moveTip(ev) {
  const pad = 14;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  const r = tooltip.getBoundingClientRect();
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}
function hideTip() { tooltip.classList.add('hidden'); }
function tipOn(el, html) {
  el.addEventListener('mouseenter', (ev) => showTip(html, ev));
  el.addEventListener('mousemove', moveTip);
  el.addEventListener('mouseleave', hideTip);
}

let toastTimer = null;
function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = kind;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---------- tabs & keyboard ----------
const VIEW_IDS = ['mission', 'problems', 'cost', 'knowledge', 'adapters'];
function showView(name) {
  if (!VIEW_IDS.includes(name)) name = 'mission';
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + name).classList.remove('hidden');
  if (name === 'cost') renderSankey();
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
  location.hash = b.dataset.view;
  showView(b.dataset.view);
}));

document.addEventListener('keydown', (e) => {
  const typing = /input|textarea|select/i.test(document.activeElement?.tagName ?? '');
  if (e.key === 'Escape') {
    if (!$('#drawer').classList.contains('hidden')) closeDrawer();
    else if (state.trace) setTrace(null);
    document.activeElement?.blur?.();
    return;
  }
  if (typing) return;
  if (e.key === '/') { e.preventDefault(); showView('mission'); $('#q').focus(); return; }
  const i = Number(e.key);
  if (i >= 1 && i <= 5) { location.hash = VIEW_IDS[i - 1]; showView(VIEW_IDS[i - 1]); }
});

// ---------- trace ----------
function setTrace(trace) {
  state.trace = trace;
  const bar = $('#trace-bar');
  if (!trace) bar.classList.add('hidden');
  else {
    bar.classList.remove('hidden');
    $('#trace-label').textContent = trace.label;
  }
  applyTrace();
}
$('#trace-clear').addEventListener('click', () => setTrace(null));

function sessionMatchesTrace(s) {
  const t = state.trace;
  if (!t) return false;
  if (t.sessionId && s.id !== t.sessionId) return false;
  if (t.agent && s.agent_id !== t.agent) return false;
  if (t.provider && s.provider_id !== t.provider) return false;
  if (t.model && s.model_id !== t.model) return false;
  if (t.project && s.cwd !== t.project) return false;
  return true;
}

function applyTrace() {
  document.querySelectorAll('#sessions-table tbody tr').forEach((tr) => {
    const s = state.sessions.find((x) => x.id === tr.dataset.id);
    tr.classList.toggle('hl-row', !!s && sessionMatchesTrace(s));
  });
  document.querySelectorAll('.sankey-node').forEach((g) => {
    g.classList.toggle('dimmed', !!state.trace && !nodeMatchesTrace(g.dataset.id));
  });
  document.querySelectorAll('.sankey-link').forEach((p) => {
    const hit = !!state.trace && nodeMatchesTrace(p.dataset.source) && nodeMatchesTrace(p.dataset.target);
    p.classList.toggle('hl', hit);
    p.classList.toggle('dimmed', !!state.trace && !hit);
  });
}

function nodeMatchesTrace(nodeId) {
  const t = state.trace;
  if (!t) return true;
  const [prefix, ...rest] = nodeId.split(':');
  const value = rest.join(':');
  if (prefix === 'p') return !t.provider || t.provider === value;
  if (prefix === 'm') return !t.model || t.model === value;
  if (prefix === 'a') return !t.agent || t.agent === value;
  if (prefix === 'j') return !t.project || t.project === value;
  return true;
}

function traceFromNode(nodeId, label) {
  const [prefix, ...rest] = nodeId.split(':');
  const value = rest.join(':');
  const map = { p: 'provider', m: 'model', a: 'agent', j: 'project' };
  setTrace({ label, [map[prefix]]: value === '?' ? undefined : value });
}

// ---------- mission: KPI + daily chart ----------
async function loadMission() {
  [state.sessions, state.overview, state.daily] = await Promise.all([
    api('sessions'), api('overview'), api('daily'),
  ]);
  renderKpis();
  renderDaily();
  renderMission();
}

function sparkline(values, color) {
  const w = 64, h = 24;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) =>
    `${(i / (values.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(' ');
  const svg = svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  svg.appendChild(svgEl('polyline', {
    points: pts, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round',
  }));
  return svg;
}

function kpi(label, value, sub, opts = {}) {
  const div = document.createElement('div');
  div.className = 'kpi' + (opts.live ? ' live' : '');
  div.innerHTML = `<div class="kpi-label">${esc(label)}</div>
    <div class="kpi-value" ${opts.title ? `title="${escAttr(opts.title)}"` : ''}>${value}</div>
    <div class="kpi-sub">${esc(sub ?? '')}</div>`;
  if (opts.spark) div.appendChild(sparkline(opts.spark, opts.color ?? '#58a6ff'));
  return div;
}

function renderKpis() {
  const t = state.overview?.totals ?? {};
  const active = state.sessions.filter((s) => s.active).length;
  const strip = $('#kpi-strip');
  strip.innerHTML = '';
  const tokSpark = state.daily.map((d) => d.tokens);
  const costSpark = state.daily.map((d) => d.cost);
  strip.appendChild(kpi('sessions', String(t.sessions ?? state.sessions.length), 'all ingested', { spark: state.daily.map((d) => d.sessions), color: '#8b97a3' }));
  strip.appendChild(kpi('active now', String(active), 'last 5 min', { live: active > 0 }));
  strip.appendChild(kpi('tokens', fmtTokens(t.tokens ?? 0), '28-day trend', { spark: tokSpark, color: '#58a6ff' }));
  strip.appendChild(kpi('est. cost', fmtCost(t.cost ?? 0), '28-day trend', { spark: costSpark, color: '#3fb950' }));
  strip.appendChild(kpi('tool calls', fmtTokens(t.tool_calls ?? 0), 'across sessions'));
}

function renderDaily() {
  const container = $('#daily-chart');
  container.innerHTML = '';
  const metric = state.dmetric;
  const data = state.daily;
  if (!data.length) return;

  const W = Math.max(container.clientWidth || 900, 500), H = 130, padL = 6, padR = 6, padT = 14, padB = 18;
  const max = Math.max(...data.map((d) => d[metric]), 1);
  const bw = (W - padL - padR) / data.length;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H });

  data.forEach((d, i) => {
    const v = d[metric];
    const h = v > 0 ? Math.max((v / max) * (H - padT - padB), 2) : 0;
    const x = padL + i * bw + bw * 0.18;
    const g = svgEl('g');
    g.classList.add('bar-day');
    if (h > 0) {
      const rect = svgEl('rect', {
        x, y: H - padB - h, width: bw * 0.64, height: h, rx: 2,
        fill: d.day === data[data.length - 1].day ? '#58a6ff' : '#2d4a6d',
      });
      g.appendChild(rect);
    } else {
      g.appendChild(svgEl('rect', { x, y: H - padB - 1.5, width: bw * 0.64, height: 1.5, fill: '#232d38' }));
    }
    tipOn(g, `<b>${esc(d.day)}</b>\n${d.sessions} sessions · ${fmtTokens(d.tokens)} tokens\n${fmtCost(d.cost)} · ${d.tool_calls} tool calls`);
    svg.appendChild(g);
    if (i % 7 === 0 || i === data.length - 1) {
      const label = svgEl('text', { x: x + bw * 0.32, y: H - 5, 'text-anchor': 'middle' });
      label.classList.add('axis-label');
      label.textContent = d.day.slice(5);
      svg.appendChild(label);
    }
  });
  const peak = data.reduce((a, b) => (b[metric] > a[metric] ? b : a), data[0]);
  const cap = svgEl('text', { x: padL, y: 10 });
  cap.classList.add('axis-label');
  cap.textContent = `peak ${peak.day}: ${metric === 'cost' ? fmtCost(peak.cost) : fmtTokens(peak.tokens)}`;
  svg.appendChild(cap);
  container.appendChild(svg);
}

document.querySelectorAll('[data-dmetric]').forEach((b) => b.addEventListener('click', () => {
  state.dmetric = b.dataset.dmetric;
  document.querySelectorAll('[data-dmetric]').forEach((x) => x.classList.toggle('active', x === b));
  renderDaily();
}));

// ---------- mission: table ----------
function filteredSessions() {
  const q = $('#q').value.trim().toLowerCase();
  const agent = $('#agent-filter').value;
  const activeOnly = $('#active-only').checked;
  let rows = state.sessions.filter((s) => {
    if (agent && s.agent_id !== agent) return false;
    if (activeOnly && !s.active) return false;
    if (q) {
      const hay = [s.agent_id, s.model_id, s.provider_id, s.cwd, s.id].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const { key, dir } = state.sort;
  const mul = dir === 'asc' ? 1 : -1;
  const val = (s) => key === 'tokens' ? sessionTokens(s) : key === 'last_activity' ? (parseTs(s.last_activity)?.getTime() ?? 0) : s[key];
  rows.sort((a, b) => {
    const av = val(a) ?? '', bv = val(b) ?? '';
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
    return String(av).localeCompare(String(bv)) * mul;
  });
  return rows;
}

function emptyHint() {
  if ($('#active-only').checked && !state.sessions.some((s) => s.active)) return 'no active sessions right now';
  return state.sessions.length ? 'no sessions match the filter' : 'no sessions yet — run re-ingest';
}

function renderMission() {
  const sel = $('#agent-filter');
  const cur = sel.value;
  const agents = [...new Set(state.sessions.map((s) => s.agent_id))].sort();
  sel.innerHTML = '<option value="">all agents</option>' +
    agents.map((a) => `<option value="${escAttr(a)}">${esc(a)}</option>`).join('');
  sel.value = agents.includes(cur) ? cur : '';

  const rows = filteredSessions();
  const empty = $('#no-sessions');
  empty.textContent = emptyHint();
  empty.classList.toggle('hidden', rows.length > 0);
  $('#mission-summary').textContent = `${rows.length}/${state.sessions.length} sessions`;

  document.querySelectorAll('#sessions-table th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted-asc', th.dataset.sort === state.sort.key && state.sort.dir === 'asc');
    th.classList.toggle('sorted-desc', th.dataset.sort === state.sort.key && state.sort.dir === 'desc');
  });

  const tbody = $('#sessions-table tbody');
  tbody.innerHTML = '';
  for (const s of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = s.id;
    tr.innerHTML = `
      <td><span class="dot ${s.active ? 'active' : ''}" title="${s.active ? 'active' : 'idle'}"></span></td>
      <td>${badge(s.agent_id)}</td>
      <td class="mono" title="${escAttr(s.model_id ?? '?')}${s.provider_id ? ' @ ' + escAttr(s.provider_id) : ''}">${esc(s.model_id ?? '?')}</td>
      <td title="${escAttr(s.cwd ?? '')}">${esc(projName(s.cwd))}</td>
      <td class="num">${s.turns}</td>
      <td class="num">${s.tool_calls}</td>
      <td class="num">${fmtTokens(sessionTokens(s))}</td>
      <td class="num">${fmtCost(s.cost_total)}</td>
      <td class="dim" title="${escAttr(fmtAbs(s.last_activity))}">${esc(fmtTime(s.last_activity))}</td>`;
    tr.addEventListener('click', () => openDrawer(s.id));
    tbody.appendChild(tr);
  }
  applyTrace();
}

document.querySelectorAll('#sessions-table th[data-sort]').forEach((th) => th.addEventListener('click', () => {
  const key = th.dataset.sort;
  if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  else state.sort = { key, dir: key === 'agent_id' || key === 'model_id' || key === 'cwd' ? 'asc' : 'desc' };
  renderMission();
}));
$('#q').addEventListener('input', renderMission);
$('#agent-filter').addEventListener('change', renderMission);
$('#active-only').addEventListener('change', renderMission);

$('#ingest-btn').addEventListener('click', async () => {
  const btn = $('#ingest-btn');
  btn.disabled = true; btn.textContent = '⟳ ingesting…';
  const r = await api('ingest', {});
  await loadMission();
  btn.disabled = false; btn.textContent = '⟳ re-ingest';
  toast(`ingested ${r.sessions ?? 0} sessions from ${r.files ?? 0} files`);
});

// ---------- session drawer ----------
const TOKEN_SEGS = [
  ['input_tokens', 'input', '#58a6ff'],
  ['output_tokens', 'output', '#3fb950'],
  ['cache_read_tokens', 'cache read', '#d2a8ff'],
  ['cache_write_tokens', 'cache write', '#d29922'],
  ['reasoning_tokens', 'reasoning', '#ff7b9c'],
];

async function openDrawer(sessionId) {
  clearTimeout(drawerHideTimer);
  let d;
  try {
    d = await api('session/' + encodeURIComponent(sessionId));
  } catch (e) {
    toast('failed to load session: ' + e, 'err');
    return;
  }
  if (!d.session) { toast(d.message ?? 'session not found', 'err'); return; }
  const s = d.session;
  const total = TOKEN_SEGS.reduce((a, [k]) => a + (s[k] ?? 0), 0) || 1;

  const body = $('#drawer-body');
  body.innerHTML = `
    <button class="close-x" title="close (Esc)">✕</button>
    ${badge(s.agent_id)}
    <h2 class="mono" title="${escAttr(s.id)}">${esc(s.model_id ?? '?')} · ${esc(projName(s.cwd))}</h2>
    <div class="kv">started <b>${esc(fmtAbs(s.started_at))}</b> · last activity <b>${esc(fmtTime(s.last_activity))}</b>
      ${s.active ? ' · <span style="color:var(--green)">● active</span>' : ''}</div>
    ${s.provider_id ? `<div class="kv">provider <b>${esc(s.provider_id)}</b></div>` : ''}
    ${d.problems.length ? `<div class="kv">problems: ${d.problems.map((p) => `<span class="tag">${esc(p.title)}</span>`).join('')}</div>` : ''}
    <div class="mini-kpis">
      <div class="mini-kpi"><div class="k">turns</div><div class="v">${s.turns}</div></div>
      <div class="mini-kpi"><div class="k">tools</div><div class="v">${s.tool_calls}</div></div>
      <div class="mini-kpi"><div class="k">tokens</div><div class="v">${fmtTokens(sessionTokens(s))}</div></div>
      <div class="mini-kpi"><div class="k">cost</div><div class="v">${fmtCost(s.cost_total)}</div></div>
    </div>

    <div class="drawer-sec">
      <h4>token breakdown</h4>
      <div class="segbar">${TOKEN_SEGS.filter(([k]) => s[k] > 0).map(([k, , c]) =>
        `<div style="width:${((s[k] / total) * 100).toFixed(2)}%;background:${c}" title="${k}: ${fmtTokens(s[k])}"></div>`).join('') || '<div style="width:100%"></div>'}</div>
      <div class="legend">${TOKEN_SEGS.map(([k, label, c]) =>
        `<span><i style="background:${c}"></i>${label} <b class="mono">${fmtTokens(s[k] ?? 0)}</b></span>`).join('')}</div>
    </div>

    <div class="drawer-sec"><h4>turns · tokens per assistant reply</h4><div id="drawer-turns"></div></div>
    ${d.tools.length ? `<div class="drawer-sec"><h4>tool usage</h4>${d.tools.slice(0, 12).map((t) =>
      `<div class="tool-row"><span>${esc(t.name)}</span><span class="c">×${t.count}</span></div>`).join('')}</div>` : ''}

    <div class="drawer-actions">
      <button id="drawer-trace" class="primary">⌖ trace this session</button>
      <button id="drawer-copy">copy id</button>
    </div>`;

  renderTurnChart($('#drawer-turns'), d.turns);

  body.querySelector('.close-x').addEventListener('click', closeDrawer);
  $('#drawer-trace').addEventListener('click', () => {
    setTrace({
      label: `session ${s.id.slice(0, 8)} (${s.agent_id} · ${s.model_id ?? '?'} · ${projName(s.cwd)})`,
      sessionId: s.id, agent: s.agent_id, provider: s.provider_id, model: s.model_id, project: s.cwd,
    });
    closeDrawer();
    toast('trace set — related rows & flow are highlighted');
  });
  $('#drawer-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(s.id);
      toast('session id copied');
    } catch {
      toast('clipboard unavailable in this context', 'err');
    }
  });

  const drawer = $('#drawer');
  drawer.classList.remove('hidden');
  requestAnimationFrame(() => drawer.classList.add('open'));
}

let drawerHideTimer = null;
function closeDrawer() {
  const drawer = $('#drawer');
  drawer.classList.remove('open');
  clearTimeout(drawerHideTimer);
  drawerHideTimer = setTimeout(() => drawer.classList.add('hidden'), 220);
}

function renderTurnChart(container, turns) {
  const rows = turns.filter((t) => t.role === 'assistant' && (t.input_tokens || t.output_tokens));
  if (!rows.length) { container.innerHTML = '<div class="hint">no usage data recorded</div>'; return; }
  const W = Math.max(container.clientWidth || 420, 200), H = 90, padB = 4;
  const max = Math.max(...rows.map((t) => t.input_tokens + t.output_tokens), 1);
  const bw = W / rows.length;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H });
  rows.forEach((t, i) => {
    const tot = t.input_tokens + t.output_tokens;
    const h = Math.max((tot / max) * (H - padB - 4), 1.5);
    const hOut = tot > 0 ? (t.output_tokens / tot) * h : 0;
    const x = i * bw + bw * 0.15;
    const g = svgEl('g');
    g.appendChild(svgEl('rect', { x, y: H - padB - h, width: bw * 0.7, height: h - hOut, fill: '#2d4a6d' }));
    if (hOut > 0) g.appendChild(svgEl('rect', { x, y: H - padB - hOut, width: bw * 0.7, height: hOut, fill: '#3fb950' }));
    tipOn(g, `<b>turn ${i + 1}</b>${t.model_id ? '\n' + esc(t.model_id) : ''}\nin ${fmtTokens(t.input_tokens)} · out ${fmtTokens(t.output_tokens)}\n${fmtCost(t.cost)}`);
    svg.appendChild(g);
  });
  container.appendChild(svg);
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = '<span><i style="background:#2d4a6d"></i>input</span><span><i style="background:#3fb950"></i>output</span>';
  container.appendChild(legend);
}

// ---------- sankey ----------
let sankeySeq = 0;
const LAYER_COLORS = ['#d2a8ff', '#58a6ff', '#3fb950', '#d29922'];
const LAYER_NAMES = ['provider', 'model', 'application', 'project'];

async function renderSankey() {
  const metric = document.querySelector('input[name="metric"]:checked').value;
  const token = ++sankeySeq;
  const data = await api('sankey?metric=' + metric);
  if (token !== sankeySeq) return; // stale response superseded
  const container = $('#sankey');
  container.innerHTML = '';
  if (!data.nodes.length) {
    container.innerHTML = '<div class="hint">no session data yet — run re-ingest on Mission Control</div>';
    return;
  }
  const fmt = (v) => metric === 'cost' ? fmtCost(v) : fmtTokens(v);

  const W = Math.max(container.clientWidth - 32, 900), H = 520, nodeW = 14, padTop = 24, padBottom = 12, gap = 9;
  const layers = [0, 1, 2, 3].map((l) => data.nodes.filter((n) => n.layer === l).sort((a, b) => b.value - a.value));
  const maxSum = Math.max(...layers.map((ns) => ns.reduce((a, n) => a + n.value, 0)));
  const availH = H - padTop - padBottom - gap * Math.max(...layers.map((ns) => ns.length - 1), 0);
  const scale = availH / maxSum;
  const colX = (l) => 70 + l * ((W - 220) / 3);

  const pos = new Map();
  layers.forEach((ns, l) => {
    let y = padTop;
    for (const n of ns) {
      const h = Math.max(n.value * scale, 2);
      pos.set(n.id, { x: colX(l), y, h, node: n });
      y += h + gap;
    }
  });

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  LAYER_NAMES.forEach((name, l) => {
    const t = svgEl('text', { x: colX(l) + (l < 2 ? nodeW + 6 : -6), y: 12, 'text-anchor': l < 2 ? 'start' : 'end' });
    t.classList.add('axis-label');
    t.textContent = name.toUpperCase();
    svg.appendChild(t);
  });

  const sOff = new Map(), tOff = new Map();
  for (const link of data.links.sort((a, b) => b.value - a.value)) {
    const s = pos.get(link.source), t = pos.get(link.target);
    if (!s || !t) continue;
    const w = Math.max(link.value * scale, 1);
    const sy = s.y + (sOff.get(link.source) ?? 0) + w / 2;
    const ty = t.y + (tOff.get(link.target) ?? 0) + w / 2;
    sOff.set(link.source, (sOff.get(link.source) ?? 0) + w);
    tOff.set(link.target, (tOff.get(link.target) ?? 0) + w);
    const x0 = s.x + nodeW, x1 = t.x, xm = (x0 + x1) / 2;
    const path = svgEl('path', {
      d: `M${x0},${sy} C${xm},${sy} ${xm},${ty} ${x1},${ty}`,
      stroke: LAYER_COLORS[s.node.layer], 'stroke-width': w,
    });
    path.classList.add('sankey-link');
    path.dataset.source = link.source;
    path.dataset.target = link.target;
    tipOn(path, `${esc(s.node.label)} → ${esc(t.node.label)}\n${fmt(link.value)}`);
    svg.appendChild(path);
  }

  for (const [id, p] of pos) {
    const g = svgEl('g');
    g.classList.add('sankey-node');
    g.dataset.id = id;
    g.appendChild(svgEl('rect', { x: p.x, y: p.y, width: nodeW, height: p.h, fill: LAYER_COLORS[p.node.layer], rx: 2 }));
    const onRight = p.node.layer < 2;
    const text = svgEl('text', {
      x: onRight ? p.x + nodeW + 6 : p.x - 6, y: p.y + p.h / 2 + 4,
      'text-anchor': onRight ? 'start' : 'end',
    });
    text.classList.add('sankey-label');
    text.innerHTML = `${esc(p.node.label)} <tspan class="val">${fmt(p.node.value)}</tspan>`;
    tipOn(g, `<b>${esc(p.node.label)}</b>\n${LAYER_NAMES[p.node.layer]} · ${fmt(p.node.value)}\nclick to trace`);
    g.appendChild(text);
    g.addEventListener('click', () => traceFromNode(id, p.node.label));
    svg.appendChild(g);
  }
  container.appendChild(svg);
  applyTrace();
}

document.querySelectorAll('input[name="metric"]').forEach((r) => r.addEventListener('change', renderSankey));

// ---------- problems ----------
async function loadProblems() {
  state.problems = await api('problems');
  renderProblems();
}

function renderProblems() {
  const list = $('#problem-list');
  list.innerHTML = '';
  const { problems, assignments } = state.problems;
  $('#subject-list').innerHTML = (state.knowledge?.subjects ?? []).map((s) => `<option value="${escAttr(s.name)}">`).join('');
  if (!problems.length) list.innerHTML = '<div class="hint">no problems yet — add one above</div>';
  for (const p of problems) {
    const card = document.createElement('div');
    card.className = 'card';
    const mine = assignments.filter((a) => a.problem_id === p.id);
    card.innerHTML = `
      <div class="adapter-head">
        <h3>${esc(p.title)}</h3>
        <span><span class="tag">${esc(p.status)}</span>${p.subject_name ? `<span class="tag">${esc(p.subject_name)}</span>` : ''}</span>
      </div>
      <div class="kv">${mine.length ? mine.map((a) => `${badge(a.agent_id)} <span class="mono">${esc(a.model_id ?? '?')}</span> · ${esc(projName(a.cwd))}`).join('<br>') : 'no sessions assigned'}</div>`;
    const row = document.createElement('div');
    row.className = 'assign-row';
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">assign a session…</option>' +
      state.sessions.map((s) => `<option value="${escAttr(s.id)}">${esc(s.agent_id)} · ${esc(s.model_id ?? '?')} · ${esc(projName(s.cwd))} · ${esc(fmtTime(s.last_activity))}</option>`).join('');
    const btn = document.createElement('button');
    btn.textContent = 'Assign';
    btn.addEventListener('click', async () => {
      if (!sel.value) return;
      await api(`problems/${encodeURIComponent(p.id)}/sessions`, { sessionId: sel.value });
      toast('session assigned to “' + p.title + '”');
      await loadProblems();
    });
    row.appendChild(sel); row.appendChild(btn);
    card.appendChild(row);
    list.appendChild(card);
  }
}

$('#problem-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  await api('problems', { title: f.get('title'), subject: f.get('subject') || undefined });
  e.target.reset();
  toast('problem added');
  await loadProblems();
});

// ---------- knowledge ----------
async function loadKnowledge() {
  state.knowledge = await api('knowledge');
  renderKnowledge();
}

function renderKnowledge() {
  const list = $('#note-list');
  list.innerHTML = '';
  const { notes, links } = state.knowledge;
  if (!notes.length) list.innerHTML = '<div class="hint">no notes yet — capture a finding above</div>';
  for (const n of notes) {
    const card = document.createElement('div');
    card.className = 'card';
    const nlinks = links.filter((l) => l.note_id === n.id);
    card.innerHTML = `
      <div class="adapter-head"><h3>${esc(n.title)}</h3><span class="hint">${esc(fmtTime(n.created_at))}</span></div>
      ${n.tags ? n.tags.split(',').filter((t) => t.trim()).map((t) => `<span class="tag">${esc(t.trim())}</span>`).join('') : ''}
      <div class="kv" style="white-space:pre-wrap">${esc(n.body)}</div>
      ${nlinks.map((l) => `<span class="tag">→ ${esc(l.target_type)}:${esc(l.target_id)}</span>`).join('')}`;
    list.appendChild(card);
  }
}

$('#note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  await api('knowledge', { title: f.get('title'), body: f.get('body'), tags: f.get('tags') });
  e.target.reset();
  toast('note saved');
  await loadKnowledge();
});

// ---------- adapters ----------
async function loadAdapters() {
  state.adapters = await api('adapters');
  renderAdapters();
}

function renderAdapters() {
  const wrap = $('#adapter-cards');
  wrap.innerHTML = '';
  for (const s of state.adapters) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="adapter-head">
        <h3>${badge(s.app)} ${esc(s.displayName)}</h3>
        <span class="current">${s.current ? `${esc(s.current.providerId)} / ${esc(s.current.modelId)}` : 'not configured'}</span>
      </div>
      <div class="kv">config ${s.configPaths.filter(Boolean).map((p) => `<b>${esc(p.replace(/^\/Users\/[^/]+/, '~'))}</b>`).join(', ')}</div>
      <div class="kv">providers: ${s.providers.map((p) => `<b>${esc(p.id)}</b>`).join(', ') || '—'}</div>
      <div class="kv">models discovered: <b>${s.models.length}</b>${s.routeSupported ? '' : ' · <span class="dim">route not supported</span>'}</div>
      ${s.error ? `<div class="kv" style="color:var(--amber)">error: ${esc(s.error)}</div>` : ''}`;
    if (s.routeSupported && s.providers.length) {
      const row = document.createElement('div');
      row.className = 'assign-row';
      const provSel = document.createElement('select');
      provSel.innerHTML = s.providers.map((p) => `<option value="${escAttr(p.id)}">${esc(p.displayName)} (${esc(p.keySource ?? 'no key info')})</option>`).join('');
      const modelSel = document.createElement('select');
      const btn = document.createElement('button');
      btn.textContent = 'Route';
      btn.className = 'primary';
      const fillModels = () => {
        const models = s.models.filter((m) => !m.providerId || m.providerId === provSel.value);
        modelSel.innerHTML = models.map((m) => `<option value="${escAttr(m.id)}">${esc(m.displayName ?? m.id)}${m.contextWindow ? ` (${fmtTokens(m.contextWindow)})` : ''}</option>`).join('') || '<option value="">no models</option>';
        btn.disabled = models.length === 0;
      };
      provSel.addEventListener('change', fillModels);
      fillModels();
      if (s.current?.modelId) modelSel.value = s.current.modelId;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const r = await api('route', { app: s.app, providerId: provSel.value, modelId: modelSel.value });
        if (r.ok) toast(`${s.app} → ${provSel.value}/${modelSel.value}`, 'ok');
        else toast(r.message ?? 'route failed', 'err');
        btn.disabled = false;
        await loadAdapters();
        await loadMission();
      });
      row.appendChild(provSel); row.appendChild(modelSel); row.appendChild(btn);
      card.appendChild(row);
    }
    wrap.appendChild(card);
  }
}

// ---------- boot & auto refresh ----------
async function loadAll() {
  await loadMission();
  await Promise.all([loadProblems(), loadKnowledge(), loadAdapters()]);
}
(async function init() {
  await loadAll();
  showView(location.hash.replace('#', '') || 'mission');
  setInterval(() => { if (document.visibilityState === 'visible') loadMission(); }, 30000);
  window.addEventListener('resize', () => { renderDaily(); if (!$('#view-cost').classList.contains('hidden')) renderSankey(); });
})();
