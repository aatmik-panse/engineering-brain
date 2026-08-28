/* Engineering Brain — cockpit UI.
 * Vanilla ES module. No frameworks, no build step, no network beyond the local brain server.
 * Every agent/user-provided string goes through esc() before touching the DOM. */

const BRAIN = window.__BRAIN__ || {};
let TOKEN = BRAIN.token || new URLSearchParams(location.search).get('token') || '';

const LEVEL_NAMES = ['Direct', 'Guided', 'Investigate', 'Architecture Decision', 'System Design'];

const KIND_COLORS = {
  app: '#8b8ff5', module: '#6ea8fe', service: '#4cc2ff', frontend: '#57d9a3',
  api: '#2fbfa7', db: '#e8b750', model: '#d9a05b', job: '#c88bf2',
  queue: '#b478e8', worker: '#9a6ee0', external: '#8a8f98', ai: '#f27d9d',
  auth: '#e8626f', cache: '#f2a35c', scheduler: '#ce93d8', event: '#7bd1e8',
};
const KIND_FALLBACK = '#8a8f98';
const EVIDENCE_VALUES = ['observed', 'measured', 'inferred', 'estimated', 'unknown'];

/* ---------------------------------------------------------------- helpers */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function compactJSON(obj, max = 240) {
  let s;
  try { s = JSON.stringify(obj); } catch { s = String(obj); }
  if (s == null) s = '';
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}

function clearEmpty(container) {
  const e = container.querySelector(':scope > .empty');
  if (e) e.remove();
}

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

/* title attribute only when the string is long enough to plausibly truncate */
function titleAttr(s, threshold = 48) {
  const str = String(s ?? '');
  return str.length > threshold ? ` title="${esc(str)}"` : '';
}

function quoteHTML(text) {
  const s = String(text ?? '');
  return s ? `<p class="quote"${titleAttr(s, 200)}>${esc(s)}</p>` : '';
}

/* muted prose paragraph; long strings get a title attr (CSS clamps the rest) */
function mutedP(text) {
  const s = String(text ?? '');
  return s ? `<p class="muted"${titleAttr(s, 200)}>${esc(s)}</p>` : '';
}

function evidenceBadge(ev) {
  const raw = String(ev ?? 'unknown').toLowerCase();
  const k = EVIDENCE_VALUES.includes(raw) ? raw : 'unknown';
  return `<span class="ev ev-${k}">${esc(raw)}</span>`;
}

function bulletList(items, cls) {
  const arr = Array.isArray(items) ? items : [];
  if (arr.length === 0) return '';
  const lis = arr
    .map((i) => `<li>${esc(typeof i === 'string' ? i : compactJSON(i))}</li>`)
    .join('');
  return `<ul class="${esc(cls || 'plain-list')}">${lis}</ul>`;
}

/* The auth token is minted per server start and injected into `GET /`. After a
 * server restart the SSE stream recovers on its own, but the page still holds
 * the dead server's token — so on a 401 we re-read `/` (which embeds the fresh
 * token) and retry once. A human decision must never bounce off a stale token. */
async function refreshToken() {
  try {
    const res = await fetch('/', { cache: 'no-store' });
    if (!res.ok) return false;
    const m = (await res.text()).match(/window\.__BRAIN__\s*=\s*(\{[^<]*\})/);
    const fresh = m && JSON.parse(m[1]);
    if (fresh && typeof fresh.token === 'string' && fresh.token && fresh.token !== TOKEN) {
      TOKEN = fresh.token;
      return true;
    }
  } catch { /* server unreachable or page not parseable; caller surfaces the 401 */ }
  return false;
}

async function postJSON(path, body, retried) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-brain-token': TOKEN },
    body: JSON.stringify(body),
  });
  if (res.status === 401 && !retried && (await refreshToken())) {
    return postJSON(path, body, true);
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok || (json && json.ok === false)) {
    throw new Error((json && json.error) || `HTTP ${res.status}`);
  }
  return json || { ok: true };
}

/* ------------------------------------------------------------------ state */

const state = {
  session: null,
  meta: null,
  lastSeq: 0,
  level: null,
  pendingDecision: null,        // latest unanswered decision_needed payload
  optionsByDecision: new Map(), // decisionId -> options payload
  choicesByDecision: new Map(), // decisionId -> decision_needed choices [{ id, label }]
  activityCount: 0,
  bootRetryTimer: 0,
};

const mapModel = {
  nodes: new Map(), // id -> node record (contract schema)
  edges: new Map(), // "from\u0000to\u0000kind" -> edge record
  focus: new Set(), // node ids touched by current request
};

/* ------------------------------------------------------------- DOM handles */

const ui = {
  sessionPicker: $('#session-picker'),
  requestText: $('#request-text'),
  levelBadge: $('#level-badge'),
  escalation: $('#escalation'),
  sessionStatus: $('#session-status'),
  conn: $('#conn'),
  trail: $('#trail'),
  tabs: $('#tabs'),
  optionsBody: $('#options-body'),
  learningBody: $('#learning-body'),
  activityBody: $('#activity-body'),
  dock: $('#dock'),
  steerInput: $('#steer-input'),
  steerSend: $('#steer-send'),
  steerFlash: $('#steer-flash'),
  mapSvg: $('#map-svg'),
  mapEdgesG: $('#map-edges'),
  mapNodesG: $('#map-nodes'),
  mapLegend: $('#map-legend'),
  mapEmpty: $('#map-empty'),
  mapDetail: $('#map-detail'),
};

/* ------------------------------------------------------------------ header */

function setLevel(level, levelName) {
  const lvl = Number.isInteger(Number(level)) ? Math.max(0, Math.min(4, Number(level))) : null;
  if (lvl === null) return;
  state.level = lvl;
  ui.levelBadge.className = `level-badge lv${lvl}`;
  const name = levelName || LEVEL_NAMES[lvl] || '';
  ui.levelBadge.innerHTML = `L${lvl}<span class="level-name">${esc(name)}</span>`;
  ui.levelBadge.title = `Workflow level ${lvl}${name ? ' — ' + name : ''}`;
}

let badgeMorphTimer = 0;
function showEscalation(fromLevel, toLevel) {
  const from = Number(fromLevel), to = Number(toLevel);
  const up = to > from;
  ui.escalation.className = `escalation ${up ? 'up' : 'down'}`;
  ui.escalation.innerHTML = `${up ? '↑' : '↓'} L${esc(from)} → L${esc(to)}`;
  ui.escalation.title = up ? 'Escalated during inspection' : 'De-escalated during inspection';
  // one-shot color-morph flare on the level badge
  ui.levelBadge.classList.remove('morph');
  void ui.levelBadge.offsetWidth; // restart the animation
  ui.levelBadge.classList.add('morph');
  clearTimeout(badgeMorphTimer);
  badgeMorphTimer = setTimeout(() => ui.levelBadge.classList.remove('morph'), 900);
}

function setSessionStatus(label, tone) {
  ui.sessionStatus.className = `session-status st-${tone || 'idle'}`;
  ui.sessionStatus.innerHTML = `<span class="dot"></span><span class="label">${esc(label)}</span>`;
}

function setRequestText(text) {
  if (!text) return;
  ui.requestText.textContent = String(text);
  ui.requestText.title = String(text);
}

function setConn(status, detail) {
  const labels = { connecting: 'connecting', live: 'live', reconnecting: 'reconnecting', offline: 'offline' };
  ui.conn.className = `conn conn-${status}`;
  ui.conn.innerHTML = `<span class="dot"></span><span class="label">${esc(labels[status] || status)}</span>`;
  ui.conn.title = detail || `Event stream: ${labels[status] || status}`;
}

/* -------------------------------------------------------------------- tabs */

function activateTab(name) {
  for (const btn of $all('#tabs button')) {
    const on = btn.dataset.tab === name;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) btn.classList.remove('pulse');
  }
  for (const panel of $all('.tab-panel')) {
    panel.classList.toggle('active', panel.id === `tab-${name}`);
  }
  if (name === 'map') kickSim(0.3);
}

function pulseTab(name) {
  const btn = $(`#tabs button[data-tab="${name}"]`);
  if (btn && !btn.classList.contains('active')) btn.classList.add('pulse');
}

ui.tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) activateTab(btn.dataset.tab);
});

/* arrow keys move between tabs (buttons stay in the Tab order; Enter/Space
 * activate natively) */
ui.tabs.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const btns = $all('#tabs button');
  const i = btns.indexOf(document.activeElement);
  if (i < 0) return;
  const next = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
  next.focus();
  activateTab(next.dataset.tab);
  e.preventDefault();
});

/* -------------------------------------------------------- batched rendering
 * During journal replay (boot / session switch) hundreds of events arrive at
 * once. Instead of touching the live DOM per event (layout thrash from the
 * stick-to-bottom scroll reads), renderers append into DocumentFragments and
 * endBatch() commits them in two appends. */

let batch = null; // { trail: DocumentFragment, activity: DocumentFragment } | null

function beginBatch() {
  batch = { trail: document.createDocumentFragment(), activity: document.createDocumentFragment() };
}

function endBatch() {
  if (!batch) return;
  const b = batch;
  batch = null;
  if (b.trail.childNodes.length) {
    clearEmpty(ui.trail);
    ui.trail.appendChild(b.trail);
    ui.trail.scrollTop = ui.trail.scrollHeight;
  }
  if (b.activity.childNodes.length) {
    clearEmpty(ui.activityBody);
    ui.activityBody.appendChild(b.activity);
    trimActivity();
    ui.activityBody.scrollTop = ui.activityBody.scrollHeight;
  }
}

/* ---------------------------------------------------------- decision trail */

function trailEntry({ ts, tone, title, body }) {
  const div = document.createElement('div');
  div.className = `trail-entry tone-${tone || 'default'}${batch ? ' no-anim' : ''}`;
  div.innerHTML =
    `<div class="trail-rail"><span class="trail-dot"></span></div>` +
    `<div class="trail-content">` +
    `<div class="trail-head"><span class="trail-title">${title}</span><time>${esc(fmtTime(ts))}</time></div>` +
    `${body || ''}` +
    `</div>`;
  if (batch) {
    batch.trail.appendChild(div);
  } else {
    clearEmpty(ui.trail);
    const stick = nearBottom(ui.trail);
    ui.trail.appendChild(div);
    if (stick) ui.trail.scrollTop = ui.trail.scrollHeight;
  }
  return div;
}

function scoreChip(key, value) {
  const v = String(value ?? '').toLowerCase();
  const cls = ['low', 'medium', 'high'].includes(v) ? v : 'none';
  const label = key === 'blastRadius' ? 'blast radius' : key;
  return `<span class="chip sc-${cls}"><span class="chip-k">${esc(label)}</span>${esc(v || '—')}</span>`;
}

const trailRenderers = {
  session_start(d, ts) {
    setRequestText(d?.request);
    setSessionStatus('active', 'active');
    trailEntry({
      ts, tone: 'session',
      title: 'Session started',
      body: quoteHTML(d?.request),
    });
  },

  classified(d, ts) {
    setLevel(d?.level, d?.levelName);
    const scores = d?.scores || {};
    const chips = ['complexity', 'risk', 'uncertainty', 'reversibility', 'blastRadius']
      .filter((k) => scores?.[k] != null)
      .map((k) => scoreChip(k, scores[k]))
      .join('');
    const planned = (Array.isArray(d?.plannedSteps) ? d.plannedSteps : [])
      .map((s) => `<li class="plan-step">${esc(s)}</li>`).join('');
    const skipped = (Array.isArray(d?.skippedSteps) ? d.skippedSteps : [])
      .map((s) => `<li class="skip-step"><span>${esc(s?.step)}</span><em>${esc(s?.why)}</em></li>`).join('');
    const lvl = Math.max(0, Math.min(4, Number(d?.level) || 0));
    trailEntry({
      ts, tone: 'classified',
      title: `Classified <b class="lv-inline lv${lvl}">L${lvl}</b> ${esc(d?.levelName || LEVEL_NAMES[lvl] || '')}`,
      body:
        (chips ? `<div class="chip-row">${chips}</div>` : '') +
        mutedP(d?.rationale) +
        (planned ? `<div class="mini-title">Planned</div><ul class="step-list">${planned}</ul>` : '') +
        (skipped ? `<div class="mini-title">Skipped</div><ul class="step-list">${skipped}</ul>` : ''),
    });
  },

  reclassified(d, ts) {
    setLevel(d?.toLevel);
    showEscalation(d?.fromLevel, d?.toLevel);
    const clampLv = (v) => Math.max(0, Math.min(4, Number(v) || 0));
    const from = clampLv(d?.fromLevel), to = clampLv(d?.toLevel);
    const up = to > from;
    const entry = trailEntry({
      ts, tone: up ? 'escalate' : 'deescalate',
      title: `${up ? 'Escalated' : 'De-escalated'} <b class="resc">L${esc(d?.fromLevel)} → L${esc(d?.toLevel)}</b>`,
      body: mutedP(d?.why),
    });
    // level color morph: the marker sweeps from the old level's color to the new one
    entry.style.setProperty('--from-c', `var(--lv${from})`);
    entry.style.setProperty('--to-c', `var(--lv${to})`);
  },

  step(d, ts) {
    const status = String(d?.status || '').toLowerCase();
    const glyph = status === 'done' ? '✓' : status === 'skipped' ? '⤼' : '▸';
    trailEntry({
      ts, tone: `step-${status || 'start'}`,
      title: `<span class="step-glyph">${glyph}</span> ${esc(d?.name || 'step')} <span class="step-status">${esc(status)}</span>`,
      body: mutedP(d?.detail),
    });
  },

  inspection(d, ts) {
    const files = (Array.isArray(d?.files) ? d.files : [])
      .map((f) => `<code class="file-chip" title="${esc(f)}">${esc(f)}</code>`).join('');
    const claims = (Array.isArray(d?.claims) ? d.claims : [])
      .map((c) => `<li>${evidenceBadge(c?.evidence)}<span>${esc(c?.text)}</span></li>`).join('');
    trailEntry({
      ts, tone: 'inspection',
      title: `Inspected <b>${esc(d?.area || 'system')}</b>`,
      body:
        mutedP(d?.summary) +
        (files ? `<div class="file-row">${files}</div>` : '') +
        (claims ? `<ul class="claim-list">${claims}</ul>` : ''),
    });
  },

  system_map(d, ts) {
    upsertMap(d?.nodes, d?.edges, d?.focus);
    pulseTab('map');
    const n = Array.isArray(d?.nodes) ? d.nodes.length : 0;
    const e = Array.isArray(d?.edges) ? d.edges.length : 0;
    const f = Array.isArray(d?.focus) ? d.focus.length : 0;
    trailEntry({
      ts, tone: 'map',
      title: 'System map updated',
      body: `<p class="muted num">${n} node${n === 1 ? '' : 's'}, ${e} edge${e === 1 ? '' : 's'}${f ? `, ${f} in focus` : ''} · <a href="#" data-goto-tab="map">view map</a></p>`,
    });
  },

  concern(d, ts) {
    const sev = ['info', 'warning', 'critical'].includes(String(d?.severity)) ? d.severity : 'info';
    trailEntry({
      ts, tone: `concern-${sev}`,
      title: `<span class="concern-glyph">${sev === 'info' ? 'ℹ' : '⚠'}</span> ${esc(d?.title || 'Concern')}`,
      body:
        mutedP(d?.detail) +
        (d?.recommendation ? `<p class="reco"><span>Recommendation</span>${esc(d.recommendation)}</p>` : ''),
    });
  },

  options(d, ts) {
    if (d?.decisionId != null) state.optionsByDecision.set(String(d.decisionId), d);
    renderOptions(d);
    pulseTab('options');
    const opts = Array.isArray(d?.options) ? d.options : [];
    const rec = opts.find((o) => o?.recommended);
    trailEntry({
      ts, tone: 'options',
      title: `${opts.length} option${opts.length === 1 ? '' : 's'} on the table`,
      body:
        `<p class="muted">${opts.map((o) => esc(o?.name || o?.id)).join(' · ')}</p>` +
        (rec ? `<p class="muted">Recommended: <b>${esc(rec.name || rec.id)}</b></p>` : '') +
        `<p class="muted"><a href="#" data-goto-tab="options">compare in Options tab</a></p>`,
    });
  },

  decision_needed(d, ts) {
    if (d?.decisionId != null && Array.isArray(d?.choices) && d.choices.length) {
      state.choicesByDecision.set(String(d.decisionId), d.choices);
    }
    showDock(d);
    trailEntry({
      ts, tone: 'decision',
      title: `Decision needed <span class="decision-kind">${esc(d?.kind || '')}</span>`,
      body: quoteHTML(d?.prompt),
    });
  },

  implementation(d, ts) {
    const glyphs = { added: '+', modified: '±', removed: '−' };
    const changes = (Array.isArray(d?.changes) ? d.changes : [])
      .map((c) => {
        const kind = String(c?.kind || 'modified');
        return `<li class="chg chg-${esc(kind)}"><span class="chg-glyph">${esc(glyphs[kind] || '±')}</span><code>${esc(c?.file)}</code>${c?.note ? `<em>${esc(c.note)}</em>` : ''}</li>`;
      }).join('');
    trailEntry({
      ts, tone: 'implementation',
      title: 'Implementation',
      body:
        mutedP(d?.summary) +
        (changes ? `<ul class="change-list">${changes}</ul>` : ''),
    });
  },

  validation(d, ts) {
    const glyphs = { pass: '✓', fail: '✕', skipped: '–' };
    const checks = (Array.isArray(d?.checks) ? d.checks : [])
      .map((c) => {
        const r = String(c?.result || 'skipped');
        return `<li class="check check-${esc(r)}"><span class="check-glyph">${esc(glyphs[r] || '·')}</span><span>${esc(c?.name)}</span>${c?.detail ? `<em>${esc(c.detail)}</em>` : ''}</li>`;
      }).join('');
    trailEntry({
      ts, tone: 'validation',
      title: 'Validation',
      body:
        mutedP(d?.summary) +
        (checks ? `<ul class="check-list">${checks}</ul>` : ''),
    });
  },

  learning(d, ts) {
    renderLearning(d, ts);
    pulseTab('learning');
    trailEntry({
      ts, tone: 'learning',
      title: 'Post-implementation report',
      body: `<p class="muted">${esc((Array.isArray(d?.whatChanged) && d.whatChanged[0]) || 'What changed, why, and what to watch next.')} · <a href="#" data-goto-tab="learning">read report</a></p>`,
    });
  },

  note(d, ts) {
    trailEntry({ ts, tone: 'note', title: 'Note', body: mutedP(d?.text) });
  },

  user_action(d, ts) {
    const type = String(d?.type || '');
    let title = 'You';
    let body = '';
    if (type === 'decision') {
      const key = String(d?.decisionId ?? '');
      const opts = state.optionsByDecision.get(key);
      const chosen = (Array.isArray(opts?.options) ? opts.options : []).find((o) => String(o?.id) === String(d?.choiceId));
      const choice = (state.choicesByDecision.get(key) || []).find((c) => String(c?.id) === String(d?.choiceId));
      title = `You chose <b>${esc(chosen?.name || choice?.label || d?.choiceId)}</b>`;
    } else if (type === 'steer') {
      title = 'You steered';
      body = quoteHTML(d?.message);
    } else if (type === 'answer') {
      title = 'You answered';
      body = quoteHTML(d?.message);
    } else {
      title = `You · ${esc(type || 'action')}`;
      body = `<p class="muted"><code>${esc(compactJSON(d))}</code></p>`;
    }
    if (d?.decisionId != null && state.pendingDecision &&
        String(state.pendingDecision.decisionId) === String(d.decisionId) && type !== 'steer') {
      hideDock();
    }
    trailEntry({ ts, tone: 'user', title, body });
  },

  session_end(d, ts) {
    const outcome = String(d?.outcome || 'completed');
    setSessionStatus(outcome.replace('_', ' '), outcome === 'completed' ? 'done' : 'ended');
    trailEntry({
      ts, tone: 'session',
      title: `Session ended — ${esc(outcome.replace('_', ' '))}`,
      body: '',
    });
  },
};

function renderUnknown(env) {
  trailEntry({
    ts: env?.ts, tone: 'unknown',
    title: `${esc(env?.type || 'event')}`,
    body: `<p class="muted"><code>${esc(compactJSON(env?.data))}</code></p>`,
  });
}

/* delegated links: jump to tab from trail entries */
ui.trail.addEventListener('click', (e) => {
  const a = e.target.closest('[data-goto-tab]');
  if (a) { e.preventDefault(); activateTab(a.dataset.gotoTab); }
});

/* ---------------------------------------------------------------- activity */

const ACTIVITY_CAP = 300;
let activityCapNote = null;

function activityRow(env) {
  const row = document.createElement('div');
  row.className = 'act-row';
  const json = compactJSON(env?.data);
  row.innerHTML =
    `<span class="act-seq num">#${esc(env?.seq ?? '·')}</span>` +
    `<time class="num">${esc(fmtTime(env?.ts))}</time>` +
    `<span class="act-type">${esc(env?.type || '?')}</span>` +
    `<code class="act-json" title="${esc(compactJSON(env?.data, 800))}">${esc(json)}</code>`;
  state.activityCount += 1;
  if (batch) {
    batch.activity.appendChild(row);
    return;
  }
  clearEmpty(ui.activityBody);
  const stick = nearBottom(ui.activityBody);
  ui.activityBody.appendChild(row);
  trimActivity();
  if (stick) ui.activityBody.scrollTop = ui.activityBody.scrollHeight;
}

/* keep the Activity DOM bounded: last ACTIVITY_CAP rows + a note that older
 * rows were dropped (the journal keeps everything). */
function trimActivity() {
  if (state.activityCount <= ACTIVITY_CAP) return;
  const rows = ui.activityBody.getElementsByClassName('act-row'); // live list
  let excess = state.activityCount - ACTIVITY_CAP;
  while (excess-- > 0 && rows.length) rows[0].remove();
  state.activityCount = ACTIVITY_CAP;
  if (!activityCapNote || !activityCapNote.isConnected) {
    activityCapNote = document.createElement('div');
    activityCapNote.className = 'act-cap-note';
    activityCapNote.textContent = `Showing the last ${ACTIVITY_CAP} events — the full journal keeps everything.`;
    ui.activityBody.prepend(activityCapNote);
  }
}

/* ----------------------------------------------------------------- options */

function scoreBar(score, note) {
  const s = Math.max(0, Math.min(5, Math.round(Number(score) || 0)));
  let cells = '';
  for (let i = 1; i <= 5; i++) cells += `<span class="bar-cell${i <= s ? ' on' : ''}"></span>`;
  const t = note ? ` title="${esc(note)}"` : '';
  return `<span class="bar"${t}>${cells}</span><span class="bar-num num">${s || '·'}</span>`;
}

function renderOptions(data) {
  const dims = Array.isArray(data?.comparisonDimensions) ? data.comparisonDimensions : [];
  const opts = Array.isArray(data?.options) ? data.options : [];
  if (opts.length === 0) return;

  const cards = opts.map((o) => {
    const rows = dims.map((dim) => {
      const cell = o?.scores?.[dim] || {};
      return `<div class="score-row"><span class="score-dim" title="${esc(dim)}${cell?.note ? esc(' — ' + cell.note) : ''}">${esc(dim)}</span>${scoreBar(cell?.score, cell?.note)}</div>`;
    }).join('');
    const pros = (Array.isArray(o?.pros) ? o.pros : [])
      .map((p) => `<li class="pro">${esc(p)}</li>`).join('');
    const cons = (Array.isArray(o?.cons) ? o.cons : [])
      .map((c) => `<li class="con">${esc(c)}</li>`).join('');
    return (
      `<article class="option-card${o?.recommended ? ' recommended' : ''}">` +
      (o?.recommended ? `<span class="rec-tag">Recommended</span>` : '') +
      `<header>` +
      `<span class="opt-id num">${esc(o?.id)}</span>` +
      `<h3>${esc(o?.name || o?.id)}</h3>` +
      (o?.tagline ? `<p class="tagline">${esc(o.tagline)}</p>` : '') +
      (o?.effort ? `<span class="effort">effort: ${esc(o.effort)}</span>` : '') +
      `</header>` +
      (rows ? `<div class="scores">${rows}</div>` : '') +
      ((pros || cons) ? `<div class="pros-cons"><ul>${pros}${cons}</ul></div>` : '') +
      (o?.debt ? `<p class="debt"><span>Debt</span>${esc(o.debt)}</p>` : '') +
      (o?.why ? `<p class="why">${esc(o.why)}</p>` : '') +
      `</article>`
    );
  }).join('');

  ui.optionsBody.innerHTML =
    `<div class="options-meta muted num">Decision ${esc(data?.decisionId ?? '')} · ${opts.length} options · ${dims.length} dimensions</div>` +
    `<div class="options-grid">${cards}</div>`;
}

/* ---------------------------------------------------------------- learning */

function renderLearning(d, ts) {
  const section = (title, content) => content
    ? `<section class="learn-section"><h3>${esc(title)}</h3>${content}</section>`
    : '';
  const para = (v) => (v ? `<p>${esc(v)}</p>` : '');
  ui.learningBody.innerHTML =
    `<div class="learn-report">` +
    `<div class="learn-head"><h2>Post-implementation report</h2><time class="num">${esc(fmtTime(ts))}</time></div>` +
    section('What changed', bulletList(d?.whatChanged, 'learn-list')) +
    section('How it works now', para(d?.howItWorksNow)) +
    section('Why this approach', para(d?.whyThisApproach)) +
    section('What was avoided', para(d?.whatWasAvoided)) +
    section('New risks', bulletList(d?.newRisks, 'learn-list risky')) +
    section('What to watch next', bulletList(d?.watchNext, 'learn-list watch')) +
    `</div>`;
}

/* ----------------------------------------------------------- decision dock */

function showDock(d) {
  state.pendingDecision = d || {};
  const decisionId = d?.decisionId;
  let choices = Array.isArray(d?.choices) && d.choices.length ? d.choices : null;
  if (!choices && decisionId != null) {
    const opts = state.optionsByDecision.get(String(decisionId));
    if (Array.isArray(opts?.options) && opts.options.length) {
      choices = opts.options.map((o) => ({
        id: o?.id, label: o?.name || o?.id, recommended: !!o?.recommended,
      }));
    }
  }
  const buttons = (choices || []).map((c) =>
    `<button type="button" class="dock-choice${c?.recommended ? ' rec' : ''}" data-choice-id="${esc(c?.id)}">` +
    `${esc(c?.label || c?.id)}${c?.recommended ? '<span class="mini-rec">recommended</span>' : ''}` +
    `</button>`
  ).join('');

  ui.dock.innerHTML =
    `<div class="dock-inner">` +
    `<div class="dock-head">` +
    `<span class="dock-kind">${esc(d?.kind || 'decision')}</span>` +
    `<p class="dock-prompt">${esc(d?.prompt || 'The brain needs your input.')}</p>` +
    `</div>` +
    (buttons ? `<div class="dock-choices">${buttons}</div>` : '') +
    `<div class="dock-answer">` +
    `<input id="dock-input" type="text" autocomplete="off" spellcheck="false" placeholder="Or answer in your own words…">` +
    `<button type="button" id="dock-answer-send">Answer</button>` +
    `</div>` +
    `<div class="dock-error hidden" id="dock-error"></div>` +
    `</div>`;
  ui.dock.classList.remove('hidden');

  const setBusy = (busy) => {
    for (const b of $all('button', ui.dock)) b.disabled = busy;
    const input = $('#dock-input', ui.dock);
    if (input) input.disabled = busy;
  };
  const fail = (err) => {
    setBusy(false);
    const box = $('#dock-error', ui.dock);
    if (box) { box.textContent = `Could not send: ${err?.message || err}`; box.classList.remove('hidden'); }
  };

  for (const btn of $all('.dock-choice', ui.dock)) {
    btn.addEventListener('click', async () => {
      setBusy(true);
      try {
        await sendAction({ type: 'decision', decisionId, choiceId: btn.dataset.choiceId });
        hideDock();
      } catch (err) { fail(err); }
    });
  }
  const input = $('#dock-input', ui.dock);
  const send = async () => {
    const message = (input?.value || '').trim();
    if (!message) return;
    setBusy(true);
    try {
      await sendAction({ type: 'answer', decisionId, message });
      hideDock();
    } catch (err) { fail(err); }
  };
  $('#dock-answer-send', ui.dock)?.addEventListener('click', send);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  if (!batch) {
    // keyboard-first: land on the recommended choice (Tab walks the rest,
    // Enter activates); fall back to the free-text input
    const first = $('.dock-choice.rec', ui.dock) || $('.dock-choice', ui.dock) || input;
    first?.focus();
  }
}

function hideDock() {
  state.pendingDecision = null;
  ui.dock.classList.add('hidden');
  ui.dock.innerHTML = '';
}

async function sendAction(action) {
  return postJSON('/decide', { session: state.session, action });
}

/* ---------------------------------------------------------------- steer box */

async function sendSteer() {
  const message = (ui.steerInput.value || '').trim();
  if (!message || !state.session) return;
  ui.steerSend.disabled = true;
  try {
    await sendAction({ type: 'steer', message });
    ui.steerInput.value = '';
    flashSteer('sent');
  } catch (err) {
    flashSteer(`failed: ${err?.message || err}`, true);
  } finally {
    ui.steerSend.disabled = false;
  }
}
let steerFlashTimer = 0;
function flashSteer(text, isError) {
  ui.steerFlash.textContent = text;
  ui.steerFlash.classList.toggle('error', !!isError);
  ui.steerFlash.classList.add('show');
  clearTimeout(steerFlashTimer);
  steerFlashTimer = setTimeout(() => ui.steerFlash.classList.remove('show'), 2500);
}
ui.steerSend.addEventListener('click', sendSteer);
ui.steerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendSteer(); });

/* ------------------------------------------------------- system map: model */

function edgeKey(e) { return `${e?.from}\u0000${e?.to}\u0000${e?.kind}`; }

function upsertMap(nodes, edges, focus) {
  for (const n of (Array.isArray(nodes) ? nodes : [])) {
    if (!n || n.id == null) continue;
    const id = String(n.id);
    mapModel.nodes.set(id, { ...(mapModel.nodes.get(id) || {}), ...n, id });
  }
  for (const e of (Array.isArray(edges) ? edges : [])) {
    if (!e || e.from == null || e.to == null) continue;
    mapModel.edges.set(edgeKey(e), { ...(mapModel.edges.get(edgeKey(e)) || {}), ...e });
  }
  if (Array.isArray(focus)) mapModel.focus = new Set(focus.map(String));
  rebuildMapView();
}

function loadMapFile(map) {
  mapModel.nodes.clear();
  mapModel.edges.clear();
  for (const n of (Array.isArray(map?.nodes) ? map.nodes : [])) {
    if (!n || n.id == null) continue;
    mapModel.nodes.set(String(n.id), { ...n, id: String(n.id) });
  }
  for (const e of (Array.isArray(map?.edges) ? map.edges : [])) {
    if (!e || e.from == null || e.to == null) continue;
    mapModel.edges.set(edgeKey(e), { ...e });
  }
  rebuildMapView();
}

/* -------------------------------------------------- system map: simulation */

const MAP_W = 1200, MAP_H = 800, MARGIN = 40;
const sim = {
  nodes: [],            // { id, x, y, vx, vy, r, degree, data, el, ring, circle }
  byId: new Map(),
  edges: [],            // { from: simNode, to: simNode, data, el }
  alpha: 0,
  raf: 0,
  drag: null,           // { node, moved }
  selectedId: null,
};

function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function seedPos(id) {
  const h = hash32(String(id));
  const a = h / 4294967296;
  const b = (Math.imul(h ^ 0x9e3779b9, 2654435761) >>> 0) / 4294967296;
  return { x: MAP_W * (0.14 + 0.72 * a), y: MAP_H * (0.14 + 0.72 * b) };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in (attrs || {})) el.setAttribute(k, attrs[k]);
  return el;
}

function rebuildMapView() {
  // sync sim nodes with model, keeping existing positions
  const seen = new Set();
  for (const [id, data] of mapModel.nodes) {
    seen.add(id);
    let n = sim.byId.get(id);
    if (!n) {
      const p = seedPos(id);
      n = { id, x: p.x, y: p.y, vx: 0, vy: 0, r: 12, degree: 0, data, el: null };
      sim.byId.set(id, n);
      sim.nodes.push(n);
    } else {
      n.data = data;
    }
  }
  sim.nodes = sim.nodes.filter((n) => seen.has(n.id));
  sim.byId = new Map(sim.nodes.map((n) => [n.id, n]));

  // resolve edges to sim nodes; skip dangling references
  sim.edges = [];
  for (const e of mapModel.edges.values()) {
    const from = sim.byId.get(String(e.from));
    const to = sim.byId.get(String(e.to));
    if (from && to) sim.edges.push({ from, to, data: e, el: null });
  }
  for (const n of sim.nodes) n.degree = 0;
  for (const e of sim.edges) { e.from.degree++; e.to.degree++; }
  for (const n of sim.nodes) n.r = 11 + Math.min(7, n.degree * 1.5);

  renderMapDOM();
  renderLegend();
  ui.mapEmpty.classList.toggle('hidden', sim.nodes.length > 0);
  ui.mapLegend.classList.toggle('hidden', sim.nodes.length === 0);
  if (sim.selectedId && !sim.byId.has(sim.selectedId)) closeDetail();
  else if (sim.selectedId) renderDetail(sim.selectedId);
  kickSim(1);
}

function renderMapDOM() {
  ui.mapEdgesG.textContent = '';
  ui.mapNodesG.textContent = '';

  for (const e of sim.edges) {
    const kind = String(e.data?.kind || 'dependency');
    const line = svgEl('line', { class: `map-edge edge-${kind}`, 'marker-end': 'url(#arrow)' });
    const title = svgEl('title');
    title.textContent = `${e.data?.from} → ${e.data?.to} (${kind}, ${e.data?.evidence || 'unknown'})`;
    line.appendChild(title);
    e.el = line;
    ui.mapEdgesG.appendChild(line);
  }

  for (const n of sim.nodes) {
    const kind = String(n.data?.kind || '');
    const color = KIND_COLORS[kind] || KIND_FALLBACK;
    const g = svgEl('g', { class: 'map-node', 'data-id': n.id, tabindex: '0', role: 'button' });
    if (mapModel.focus.has(n.id)) {
      n.ring = svgEl('circle', { class: 'focus-ring', r: n.r + 6, stroke: color });
      g.appendChild(n.ring);
    } else {
      n.ring = null;
    }
    n.circle = svgEl('circle', { class: 'node-body', r: n.r, fill: color });
    g.appendChild(n.circle);
    const label = svgEl('text', { class: 'node-label', y: n.r + 14, 'text-anchor': 'middle' });
    label.textContent = String(n.data?.name || n.id);
    g.appendChild(label);
    const title = svgEl('title');
    title.textContent = `${n.data?.name || n.id} (${kind || 'node'})`;
    g.appendChild(title);
    n.el = g;
    ui.mapNodesG.appendChild(g);
  }
  applySelectionClass();
  updatePositions();
}

function renderLegend() {
  const kinds = [...new Set(sim.nodes.map((n) => String(n.data?.kind || 'other')))].sort();
  ui.mapLegend.innerHTML = kinds.map((k) =>
    `<span class="legend-item"><span class="swatch" style="background:${esc(KIND_COLORS[k] || KIND_FALLBACK)}"></span>${esc(k)}</span>`
  ).join('');
}

function kickSim(alpha) {
  sim.alpha = Math.max(sim.alpha, alpha == null ? 1 : alpha);
  if (!sim.raf && sim.nodes.length) sim.raf = requestAnimationFrame(tickSim);
}

function tickSim() {
  sim.raf = 0;
  if (sim.alpha < 0.015 || sim.nodes.length === 0) { sim.alpha = 0; return; }

  const nodes = sim.nodes;
  const REPULSION = 26000, SPRING_K = 0.015, SPRING_LEN = 150;
  const CENTER_K = 0.0045, DAMPING = 0.86, MAX_V = 14;

  for (const n of nodes) { n.fx = 0; n.fy = 0; }

  // pairwise repulsion (O(n^2) — fine at cockpit scale)
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = (hash32(a.id) % 7) - 3 || 1; dy = (hash32(b.id) % 7) - 3 || 1; d2 = dx * dx + dy * dy; }
      const d = Math.sqrt(d2);
      const f = REPULSION / d2;
      const ux = dx / d, uy = dy / d;
      a.fx += ux * f; a.fy += uy * f;
      b.fx -= ux * f; b.fy -= uy * f;
    }
  }

  // springs along edges
  for (const e of sim.edges) {
    const dx = e.to.x - e.from.x, dy = e.to.y - e.from.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = SPRING_K * (d - SPRING_LEN);
    const ux = dx / d, uy = dy / d;
    e.from.fx += ux * f; e.from.fy += uy * f;
    e.to.fx -= ux * f; e.to.fy -= uy * f;
  }

  // gentle centering + integrate
  for (const n of nodes) {
    if (sim.drag && sim.drag.node === n) { n.vx = 0; n.vy = 0; continue; }
    n.fx += (MAP_W / 2 - n.x) * CENTER_K;
    n.fy += (MAP_H / 2 - n.y) * CENTER_K;
    n.vx = (n.vx + n.fx * sim.alpha) * DAMPING;
    n.vy = (n.vy + n.fy * sim.alpha) * DAMPING;
    const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
    if (sp > MAX_V) { n.vx = (n.vx / sp) * MAX_V; n.vy = (n.vy / sp) * MAX_V; }
    n.x = Math.max(MARGIN, Math.min(MAP_W - MARGIN, n.x + n.vx));
    n.y = Math.max(MARGIN, Math.min(MAP_H - MARGIN, n.y + n.vy));
  }

  sim.alpha *= 0.985;
  updatePositions();
  sim.raf = requestAnimationFrame(tickSim);
}

function updatePositions() {
  for (const e of sim.edges) {
    if (!e.el) continue;
    // shorten the line so the arrowhead lands on the node rim
    const dx = e.to.x - e.from.x, dy = e.to.y - e.from.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const tPad = (e.to.r + 4) / d, fPad = (e.from.r + 1) / d;
    e.el.setAttribute('x1', (e.from.x + dx * fPad).toFixed(1));
    e.el.setAttribute('y1', (e.from.y + dy * fPad).toFixed(1));
    e.el.setAttribute('x2', (e.to.x - dx * tPad).toFixed(1));
    e.el.setAttribute('y2', (e.to.y - dy * tPad).toFixed(1));
  }
  for (const n of sim.nodes) {
    if (n.el) n.el.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
  }
}

/* ------------------------------------------- system map: drag / click / UI */

function svgPoint(evt) {
  const pt = ui.mapSvg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const m = ui.mapSvg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const p = pt.matrixTransform(m.inverse());
  return { x: p.x, y: p.y };
}

ui.mapSvg.addEventListener('pointerdown', (e) => {
  const g = e.target.closest('.map-node');
  if (!g) return;
  const node = sim.byId.get(g.dataset.id);
  if (!node) return;
  sim.drag = { node, moved: false, sx: e.clientX, sy: e.clientY };
  try { ui.mapSvg.setPointerCapture(e.pointerId); } catch { /* synthetic or stale pointer */ }
  e.preventDefault();
});

ui.mapSvg.addEventListener('pointermove', (e) => {
  if (!sim.drag) return;
  if (Math.abs(e.clientX - sim.drag.sx) + Math.abs(e.clientY - sim.drag.sy) > 4) sim.drag.moved = true;
  const p = svgPoint(e);
  sim.drag.node.x = Math.max(MARGIN, Math.min(MAP_W - MARGIN, p.x));
  sim.drag.node.y = Math.max(MARGIN, Math.min(MAP_H - MARGIN, p.y));
  sim.drag.node.vx = 0; sim.drag.node.vy = 0;
  kickSim(0.25); // let neighbors relax around the dragged node
  updatePositions();
});

/* keyboard: Tab reaches nodes, Enter/Space opens the detail panel */
ui.mapSvg.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const g = e.target.closest && e.target.closest('.map-node');
  if (!g) return;
  e.preventDefault();
  selectNode(g.dataset.id);
});

ui.mapSvg.addEventListener('pointerup', (e) => {
  if (!sim.drag) return;
  const { node, moved } = sim.drag;
  sim.drag = null;
  try { ui.mapSvg.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  if (!moved) selectNode(node.id);
});

function applySelectionClass() {
  for (const n of sim.nodes) {
    if (n.el) n.el.classList.toggle('selected', n.id === sim.selectedId);
  }
}

function selectNode(id) {
  sim.selectedId = id;
  applySelectionClass();
  renderDetail(id);
}

function closeDetail() {
  sim.selectedId = null;
  applySelectionClass();
  ui.mapDetail.classList.add('hidden');
  ui.mapDetail.innerHTML = '';
}

function renderDetail(id) {
  const node = mapModel.nodes.get(String(id));
  if (!node) { closeDetail(); return; }
  const kind = String(node?.kind || '');
  const color = KIND_COLORS[kind] || KIND_FALLBACK;
  const nameOf = (nid) => mapModel.nodes.get(String(nid))?.name || String(nid);

  const inbound = [], outbound = [];
  for (const e of mapModel.edges.values()) {
    if (String(e?.to) === String(id)) inbound.push(e);
    if (String(e?.from) === String(id)) outbound.push(e);
  }
  const edgeRow = (e, dir) => {
    const other = dir === 'in' ? e.from : e.to;
    return `<li><a href="#" data-node="${esc(other)}" title="${esc(nameOf(other))}">${esc(nameOf(other))}</a>` +
      `<span class="edge-kind">${esc(e?.kind || '')}</span>${evidenceBadge(e?.evidence)}</li>`;
  };

  ui.mapDetail.innerHTML =
    `<div class="detail-head">` +
    `<span class="detail-swatch" style="background:${esc(color)}"></span>` +
    `<div class="detail-title"><h3>${esc(node?.name || id)}</h3><span class="detail-kind">${esc(kind || 'node')}</span></div>` +
    `<button type="button" class="detail-close" title="Close">✕</button>` +
    `</div>` +
    `<div class="detail-section"><h4>Responsibility</h4>` +
    `<p>${esc(node?.responsibility || '—')}</p></div>` +
    `<div class="detail-section"><h4>Evidence</h4>${evidenceBadge(node?.evidence)}</div>` +
    ((Array.isArray(node?.risks) && node.risks.length)
      ? `<div class="detail-section"><h4>Risks</h4>${bulletList(node.risks, 'detail-risks')}</div>` : '') +
    `<div class="detail-section"><h4>Inbound · ${inbound.length}</h4>` +
    (inbound.length ? `<ul class="edge-list">${inbound.map((e) => edgeRow(e, 'in')).join('')}</ul>` : '<p class="muted">none</p>') +
    `</div>` +
    `<div class="detail-section"><h4>Outbound · ${outbound.length}</h4>` +
    (outbound.length ? `<ul class="edge-list">${outbound.map((e) => edgeRow(e, 'out')).join('')}</ul>` : '<p class="muted">none</p>') +
    `</div>`;
  ui.mapDetail.classList.remove('hidden');
}

ui.mapDetail.addEventListener('click', (e) => {
  if (e.target.closest('.detail-close')) { closeDetail(); return; }
  const a = e.target.closest('[data-node]');
  if (a) { e.preventDefault(); selectNode(String(a.dataset.node)); }
});

/* ------------------------------------------------------------ event intake */

function handleEnvelope(env) {
  if (!env || typeof env !== 'object') return;
  if (typeof env.seq === 'number') {
    if (env.seq <= state.lastSeq) return; // duplicate from replay overlap
    state.lastSeq = env.seq;
  }
  activityRow(env);
  try {
    const renderer = trailRenderers[env.type];
    if (renderer) renderer(env.data || {}, env.ts);
    else renderUnknown(env);
  } catch (err) {
    // never let one malformed event take the cockpit down
    renderUnknown(env);
    console.error('render error for event', env?.type, err);
  }
}

/* ------------------------------------------------------------ SSE lifecycle */

let es = null;
let backoff = 1000;

function connectSSE() {
  if (es) { try { es.close(); } catch { /* noop */ } es = null; }
  setConn(state.lastSeq ? 'reconnecting' : 'connecting');
  const url = `/events?session=${encodeURIComponent(state.session)}&since=${state.lastSeq}`;
  es = new EventSource(url);
  es.onopen = () => { setConn('live'); backoff = 1000; };
  es.onmessage = (e) => {
    let env = null;
    try { env = JSON.parse(e.data); } catch { return; }
    handleEnvelope(env);
  };
  es.onerror = () => {
    // manage reconnects ourselves so `since` always carries the latest seq
    try { es.close(); } catch { /* noop */ }
    es = null;
    setConn('reconnecting', `Retrying in ${Math.round(backoff / 1000)}s…`);
    setTimeout(connectSSE, backoff);
    backoff = Math.min(Math.round(backoff * 1.7), 15000);
  };
}

/* --------------------------------------------------------- session picker */

let sessionsCache = [];
let pickerSignature = '';

async function refreshSessions() {
  try {
    const res = await fetch('/sessions');
    if (!res.ok) return;
    const json = await res.json();
    sessionsCache = Array.isArray(json?.sessions) ? json.sessions : [];
  } catch { /* server unreachable; keep the last list */ }
  renderSessionPicker();
}

function renderSessionPicker() {
  const list = sessionsCache.filter((s) => s?.sessionId);
  if (list.length === 0) { ui.sessionPicker.classList.add('hidden'); return; }
  const html = list.map((s) => {
    const id = String(s.sessionId);
    const active = s?.status === 'active';
    const req = String(s?.request || id);
    const short = req.length > 44 ? req.slice(0, 43) + '…' : req;
    const label = `${active ? '●' : '○'} ${fmtTime(s?.startedAt).slice(0, 5)} · ${short}`;
    return `<option value="${esc(id)}"${id === state.session ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
  const signature = html; // skip DOM churn (and dropdown-closing) when nothing changed
  if (signature !== pickerSignature) {
    pickerSignature = signature;
    ui.sessionPicker.innerHTML = html;
  }
  ui.sessionPicker.classList.remove('hidden');
}

function switchSession(id) {
  if (!id || id === state.session) return;
  const url = new URL(location.href);
  url.searchParams.set('session', id);
  history.replaceState(null, '', url);
  resetSessionState();
  state.session = id;
  renderSessionPicker();
  loadSession(id); // re-subscribes SSE from seq 0
}

ui.sessionPicker.addEventListener('change', () => switchSession(ui.sessionPicker.value));

/* ------------------------------------------------------------------- boot */

/* pristine empty-state markup, restored on session switch */
const EMPTY_HTML = {
  trail: ui.trail.innerHTML,
  options: ui.optionsBody.innerHTML,
  learning: ui.learningBody.innerHTML,
  activity: ui.activityBody.innerHTML,
};

function resetSessionState() {
  if (es) { try { es.close(); } catch { /* noop */ } es = null; }
  state.session = null;
  state.meta = null;
  state.lastSeq = 0;
  state.level = null;
  state.activityCount = 0;
  state.optionsByDecision.clear();
  state.choicesByDecision.clear();
  hideDock();
  activityCapNote = null;
  for (const btn of $all('#tabs button')) btn.classList.remove('pulse');
  ui.trail.innerHTML = EMPTY_HTML.trail;
  ui.optionsBody.innerHTML = EMPTY_HTML.options;
  ui.learningBody.innerHTML = EMPTY_HTML.learning;
  ui.activityBody.innerHTML = EMPTY_HTML.activity;
  ui.levelBadge.className = 'level-badge lv-none';
  ui.levelBadge.textContent = 'L?';
  ui.levelBadge.title = '';
  ui.escalation.className = 'escalation hidden';
  ui.escalation.innerHTML = '';
  setSessionStatus('idle', 'idle');
  mapModel.focus = new Set();
}

function pickSession() {
  const fromQuery = new URLSearchParams(location.search).get('session');
  if (fromQuery) return fromQuery;
  const active = sessionsCache.find((s) => s?.status === 'active');
  return (active || sessionsCache[0])?.sessionId || null;
}

async function loadSession(session) {
  // Initial snapshot: map + full journal (replayed in one batched DOM commit),
  // then live SSE from lastSeq.
  const [mapRes, stateRes] = await Promise.all([
    fetch('/map').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`/state?session=${encodeURIComponent(session)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (state.session !== session) return; // user switched away mid-fetch

  if (mapRes) loadMapFile(mapRes);

  if (stateRes?.meta) {
    state.meta = stateRes.meta;
    setRequestText(stateRes.meta.request);
    setSessionStatus(stateRes.meta.status || 'active', stateRes.meta.status === 'ended' ? 'ended' : 'active');
  }
  beginBatch();
  try {
    for (const env of (Array.isArray(stateRes?.events) ? stateRes.events : [])) {
      handleEnvelope(env);
    }
  } finally {
    endBatch();
  }

  connectSSE();
}

async function boot() {
  clearTimeout(state.bootRetryTimer);
  await refreshSessions();
  const session = pickSession();
  if (!session) {
    setConn('offline', 'No session yet — retrying');
    setSessionStatus('waiting', 'idle');
    ui.requestText.textContent = 'No sessions yet — start the brain from your agent to begin.';
    state.bootRetryTimer = setTimeout(boot, 4000);
    return;
  }
  state.session = session;
  renderSessionPicker();
  await loadSession(session);
}

setInterval(refreshSessions, 15000);
boot();
