/* Journey Cleanup Dashboard - AJO stale journeys (30+ days) + AI Risk Scoring */
/* eslint-disable no-await-in-loop */
import {
  computeRuleScore, isDefaultJourneyName,
  scoreBadgeHtml, aiDetailHtml,
  checkProxyHealth, createAgentPool,
} from './jcc-ai-core.js';

const AJO_BASE = 'https://platform.adobe.io/ajo/journey';
const PAGE_SIZE = 50;
const ROWS_PER_PAGE = 20;
const STALE_DAYS = 30;
const SESSION_KEY = 'jcc_cfg';
const AI_SETTINGS_KEY = 'jcc_ai';

// ─── helpers ──────────────────────────────────────────────────────────────────

function cutoff() { const d = new Date(); d.setDate(d.getDate() - STALE_DAYS); return d; }

function fmtDate(iso) {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function daysAgo(iso) {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function sClass(status) {
  return ({ live: 'live', draft: 'draft', failed: 'failed', closed: 'closed', stopped: 'stopped' })[(status || '').toLowerCase()] || 'unknown';
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sc2(days) {
  if (days > 90) return 'jcc-stale-critical';
  if (days > 60) return 'jcc-stale-warn';
  return 'jcc-stale-ok';
}

function getBucket(days) {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

function getSaved() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}'); } catch (_) { return {}; } }
function getAiSettings() { try { return JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || '{}'); } catch (_) { return {}; } }
function saveAiSettings(s) { try { localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(s)); } catch (_) { /* ignore */ } }

function todayIso() { return new Date().toISOString().slice(0, 10); }

// ─── API ──────────────────────────────────────────────────────────────────────

async function apiGet(cfg, page, signal) {
  const f = `status=draft,failed,stopped,closed&metadata.lastModifiedAt<${todayIso()}`;
  const url = `${AJO_BASE}?pageSize=${PAGE_SIZE}&page=${page}&filter=${encodeURIComponent(f)}`;
  // eslint-disable-next-line no-console
  console.log(`[JCC] GET page=${page}`);
  const res = await fetch(url, {
    signal,
    headers: { Authorization: `Bearer ${cfg.token}`, 'x-api-key': cfg.apiKey, 'x-gw-ims-org-id': cfg.orgId, 'x-sandbox-name': cfg.sandbox },
  });
  if (!res.ok) { const b = await res.text().catch(() => ''); throw new Error(`HTTP ${res.status}: ${b}`); }
  return res.json();
}

function fetchAll(cfg, onChunk, onErr, onDone) {
  const ctrl = new AbortController();
  const { signal } = ctrl;
  (async () => {
    const all = [];
    let d0;
    try { d0 = await apiGet(cfg, 0, signal); } catch (e) { if (e.name === 'AbortError') { onDone([]); return; } onErr(e); onDone([]); return; }
    const items0 = d0.results || [];
    const total = d0.pagination?.totalCount ?? items0.length;
    const pages = Math.ceil(total / PAGE_SIZE);
    if (items0.length) { all.push(...items0); onChunk([...items0], [...all], 0); }
    if (pages <= 1) { onDone([...all]); return; }
    for (let p = 1; p < pages; p += 1) {
      if (signal.aborted) break;
      let d;
      try { d = await apiGet(cfg, p, signal); } catch (e) { if (e.name === 'AbortError') break; onErr(e); break; }
      const items = d.results || [];
      if (!items.length) break;
      all.push(...items);
      onChunk([...items], [...all], p);
    }
    onDone([...all]);
  })();
  return ctrl;
}

// ─── modal ────────────────────────────────────────────────────────────────────

function closeModal() { document.querySelector('.jcc-modal-overlay')?.remove(); document.body.classList.remove('jcc-no-scroll'); }

function showModal(onOk) {
  document.querySelector('.jcc-modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'jcc-modal-overlay';
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'AJO Credentials');
  const box = document.createElement('div');
  box.className = 'jcc-modal-box';
  const sv = getSaved();
  box.innerHTML = [
    '<div class="jcc-modal-header"><span class="jcc-modal-icon">&#x1F9F9;</span><div>',
    '<h2 class="jcc-modal-title">Journey Cleanup Dashboard</h2>',
    `<p class="jcc-modal-sub">Discover journeys stale for ${STALE_DAYS}+ days</p></div></div>`,
    '<form class="jcc-modal-form" id="jcc-modal-form" novalidate>',
    `<div class="jcc-field"><label class="jcc-label" for="jcc-m-token">Access Token <span class="jcc-req">*</span></label><textarea id="jcc-m-token" name="token" rows="3" placeholder="Bearer token...">${esc(sv.token || '')}</textarea><span class="jcc-field-hint">From Adobe Developer Console</span></div>`,
    '<div class="jcc-modal-row">',
    `<div class="jcc-field"><label class="jcc-label" for="jcc-m-key">API Key <span class="jcc-req">*</span></label><input id="jcc-m-key" name="apiKey" type="text" value="${esc(sv.apiKey || '')}" placeholder="x-api-key" /></div>`,
    `<div class="jcc-field"><label class="jcc-label" for="jcc-m-sb">Sandbox <span class="jcc-req">*</span></label><input id="jcc-m-sb" name="sandbox" type="text" value="${esc(sv.sandbox || '')}" placeholder="sandbox-name" /></div>`,
    '</div>',
    `<div class="jcc-field"><label class="jcc-label" for="jcc-m-org">IMS Org ID <span class="jcc-req">*</span></label><input id="jcc-m-org" name="orgId" type="text" value="${esc(sv.orgId || '')}" placeholder="xxxxx@AdobeOrg" /></div>`,
    `<div class="jcc-field"><label class="jcc-label" for="jcc-m-ten">Tenant ID <span class="jcc-req">*</span></label><input id="jcc-m-ten" name="tenantId" type="text" value="${esc(sv.tenantId || '')}" placeholder="my-tenant" /><span class="jcc-field-hint">Used to build AJO deep-link URLs</span></div>`,
    '<div class="jcc-modal-error" id="jcc-modal-err" style="display:none"></div>',
    '<div class="jcc-modal-footer"><p class="jcc-modal-note">&#x1F512; sessionStorage only.</p>',
    '<div class="jcc-modal-actions"><button type="button" class="jcc-btn-secondary jcc-modal-cancel">&#x2715; Cancel</button>',
    '<button type="submit" class="jcc-btn-primary">&#x1F680; Load Journeys</button></div></div>',
    '</form>',
  ].join('');
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  document.body.classList.add('jcc-no-scroll');
  setTimeout(() => { box.querySelector('textarea')?.focus(); }, 80);
  box.querySelector('#jcc-modal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const c = { token: (fd.get('token') || '').trim(), apiKey: (fd.get('apiKey') || '').trim(), orgId: (fd.get('orgId') || '').trim(), sandbox: (fd.get('sandbox') || '').trim(), tenantId: (fd.get('tenantId') || '').trim() };
    const errEl = box.querySelector('#jcc-modal-err');
    const missing = ['token', 'apiKey', 'orgId', 'sandbox', 'tenantId'].filter((k) => !c[k]);
    if (missing.length) { errEl.style.display = 'flex'; errEl.textContent = `\u26A0 Fill in: ${missing.join(', ')}`; return; }
    errEl.style.display = 'none';
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(c));
    closeModal(); onOk(c);
  });
  box.querySelector('.jcc-modal-cancel').addEventListener('click', closeModal);
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const els = [...overlay.querySelectorAll('button,input,textarea,[tabindex]')].filter((x) => !x.disabled);
    if (!els.length) return;
    if (e.shiftKey && document.activeElement === els[0]) { e.preventDefault(); els[els.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === els[els.length - 1]) { e.preventDefault(); els[0].focus(); }
  });
}

function readCfg(block) {
  const cfg = {};
  block.querySelectorAll(':scope > div').forEach((row) => {
    const cells = row.querySelectorAll('div');
    if (cells.length < 2) return;
    const k = cells[0].textContent.trim().toLowerCase().replace(/[^a-z]/g, '');
    const v = cells[1].textContent.trim();
    if (k === 'accesstoken' || k === 'token') cfg.token = v;
    if (k === 'apikey') cfg.apiKey = v;
    if (k === 'orgid' || k === 'imsorgid') cfg.orgId = v;
    if (k === 'sandboxname' || k === 'sandbox') cfg.sandbox = v;
    if (k === 'tenantid' || k === 'tenant') cfg.tenantId = v;
  });
  return cfg;
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function csvQ(v) { const s = String(v ?? ''); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s; }
function buildCsv(data, cfg) {
  const hdrs = ['ID', 'Name', 'Status', 'Version', 'Sandbox', 'Created By', 'Created At', 'Last Modified By', 'Last Modified At', 'Days Stale', 'AJO URL'];
  const rows = data.map((j) => [
    j.id, j.name, j.status, j.version, j.sandboxName,
    j.metadata?.createdBy, j.metadata?.createdAt,
    j.metadata?.lastModifiedBy, j.metadata?.lastModifiedAt,
    daysAgo(j.metadata?.lastModifiedAt),
    `https://experience.adobe.com/#/@${encodeURIComponent(cfg.tenantId)}/sname:${encodeURIComponent(cfg.sandbox)}/journey-optimizer/journeys/journey/${j.id}`,
  ].map(csvQ).join(','));
  return [hdrs.map(csvQ).join(','), ...rows].join('\r\n');
}

function triggerDownload(csv, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ─── dashboard ────────────────────────────────────────────────────────────────

function showDashboard(root, cfg) {
  let all = []; let filtered = []; let pg = 0;
  let nameQ = ''; let statusQ = 'all'; let createdByQ = 'all'; let bucketQ = 'all';
  let sortK = 'lastModifiedAt'; let sortD = 'asc'; let loading = true; let expanded = null;

  const aiSaved = getAiSettings();
  let aiEnabled = !!aiSaved.enabled;
  let proxyUrl = aiSaved.proxyUrl || 'http://localhost:3001';
  const aiScores = new Map();
  const aiPending = new Set();
  const detailCache = new Map();
  let agentPool = null;
  let aiRunning = false;

  root.innerHTML = '';
  const dash = document.createElement('div');
  dash.className = 'jcc-dashboard';
  dash.innerHTML = [
    // Header
    '<div class="jcc-header">',
    '  <div class="jcc-header-left"><span class="jcc-hi">&#x1F9F9;</span><div>',
    '    <h2 class="jcc-title">Journey Cleanup Dashboard</h2>',
    `    <p class="jcc-sub">Journeys not modified in <strong>${STALE_DAYS}+ days</strong></p>`,
    '  </div></div>',
    '  <div class="jcc-header-right">',
    `    <span class="jcc-sandbox-badge">${esc(cfg.sandbox)}</span>`,
    '    <button class="jcc-btn-sec" id="jr-csv-all">&#x1F4E5; All CSV</button>',
    '    <button class="jcc-btn-sec" id="jr-csv">&#x1F4E5; Filtered CSV</button>',
    '    <button class="jcc-btn-sec" id="jr-reconfig">&#x2699; Reconfigure</button>',
    '    <button class="jcc-btn-pri" id="jr-refresh" disabled>&#x21BA; Refresh</button>',
    '  </div>',
    '</div>',
    // AI bar
    '<div class="jcc-ai-bar" id="jcc-ai-bar">',
    '  <div class="jcc-ai-bar-top">',
    '    <label class="jcc-ai-toggle-lbl"><input type="checkbox" id="jcc-ai-chk"',
    aiEnabled ? ' checked' : '', ' /><span>&#x1F916; Enable LLM Analysis</span></label>',
    '    <div class="jcc-ai-cfg" id="jcc-ai-cfg" style="', aiEnabled ? '' : 'display:none', '">',
    '      <label class="jcc-ai-cfg-lbl" for="jcc-ai-url">Proxy URL:</label>',
    `      <input id="jcc-ai-url" class="jcc-ai-url" type="text" value="${esc(proxyUrl)}" placeholder="http://localhost:3001" />`,
    '      <button id="jcc-ai-health-chk" class="jcc-btn-health">&#x1F50D; Test</button>',
    '      <span id="jcc-ai-status" class="jcc-ai-status jcc-ai-s-unknown">&#x25CF; Not checked</span>',
    '    </div>',
    '    <div class="jcc-ai-actions" id="jcc-ai-actions" style="', aiEnabled ? '' : 'display:none', '">',
    '      <button id="jcc-ai-run" class="jcc-btn-ai" disabled>&#x1F916; Analyze All</button>',
    '      <button id="jcc-ai-stop" class="jcc-btn-ai-stop" style="display:none">&#x23F9; Stop</button>',
    '    </div>',
    '  </div>',
    '  <div class="jcc-ai-bar-bottom" id="jcc-ai-bar-bottom" style="display:none">',
    '    <div class="jcc-ai-prog-wrap"><div class="jcc-ai-prog-track"><div class="jcc-ai-prog-fill" id="jcc-ai-pf"></div></div>',
    '    <span id="jcc-ai-pl" class="jcc-ai-prog-lbl">Initialising\u2026</span></div>',
    '    <div class="jcc-ai-counts">',
    '      <span class="jcc-ai-cnt jcc-ai-cnt-retire" id="jcc-ai-retire">&#x1F534; 0 Retire</span>',
    '      <span class="jcc-ai-cnt jcc-ai-cnt-review" id="jcc-ai-review">&#x1F7E1; 0 Review</span>',
    '      <span class="jcc-ai-cnt jcc-ai-cnt-keep"   id="jcc-ai-keep">&#x1F7E2; 0 Keep</span>',
    '    </div>',
    '  </div>',
    '</div>',
    // Summary
    '<div class="jcc-summary">',
    '  <div class="jcc-sc jcc-sc-total"><span class="jcc-sn" id="st">\u2014</span><span class="jcc-sl">Total</span></div>',
    '  <div class="jcc-sc jcc-sc-draft"><span class="jcc-sn" id="sd">\u2014</span><span class="jcc-sl">Draft</span></div>',
    '  <div class="jcc-sc jcc-sc-failed"><span class="jcc-sn" id="sf">\u2014</span><span class="jcc-sl">Failed</span></div>',
    '  <div class="jcc-sc jcc-sc-closed"><span class="jcc-sn" id="sc">\u2014</span><span class="jcc-sl">Closed/Stopped</span></div>',
    '</div>',
    // Buckets
    '<div class="jcc-buckets">',
    '  <span class="jcc-buckets-lbl">Age Buckets:</span>',
    '  <button class="jcc-bucket-btn jcc-bucket-all jcc-bucket-active" data-bucket="all">All</button>',
    '  <button class="jcc-bucket-btn jcc-bucket-0-30"   data-bucket="0-30">0\u201330 days</button>',
    '  <button class="jcc-bucket-btn jcc-bucket-31-60"  data-bucket="31-60">31\u201360 days</button>',
    '  <button class="jcc-bucket-btn jcc-bucket-61-90"  data-bucket="61-90">61\u201390 days</button>',
    '  <button class="jcc-bucket-btn jcc-bucket-90plus" data-bucket="90+">90+ days</button>',
    '  <span class="jcc-bucket-counts">',
    '    <span class="jcc-bc-item jcc-bc-0-30">0\u201330: <strong id="bk-0-30">\u2014</strong></span>',
    '    <span class="jcc-bc-item jcc-bc-31-60">31\u201360: <strong id="bk-31-60">\u2014</strong></span>',
    '    <span class="jcc-bc-item jcc-bc-61-90">61\u201390: <strong id="bk-61-90">\u2014</strong></span>',
    '    <span class="jcc-bc-item jcc-bc-90plus">90+: <strong id="bk-90plus">\u2014</strong></span>',
    '  </span>',
    '</div>',
    // Progress
    '<div class="jcc-prog-wrap" id="jcc-pw">',
    '  <div class="jcc-prog-track"><div class="jcc-prog-fill" id="jcc-pf"></div></div>',
    '  <span class="jcc-prog-lbl" id="jcc-pl">Starting\u2026</span>',
    '  <button class="jcc-stop-btn" id="jcc-stop">&#x23F9; Stop</button>',
    '</div>',
    // Controls
    '<div class="jcc-controls">',
    '  <div class="jcc-search-wrap"><span>&#x1F50D;</span>',
    '    <input id="jcc-sq" class="jcc-search" type="text" placeholder="Search name, ID, owner\u2026" autocomplete="off" />',
    '    <button id="jcc-sq-clr" class="jcc-clr-btn" style="display:none">&#x2715;</button>',
    '  </div>',
    '  <div class="jcc-filter-row">',
    '    <div class="jcc-fg"><label for="jcc-sf">Status</label>',
    '      <select id="jcc-sf" class="jcc-sel"><option value="all">All</option><option value="draft">Draft</option><option value="failed">Failed</option><option value="closed">Closed</option><option value="stopped">Stopped</option></select>',
    '    </div>',
    '    <div class="jcc-fg"><label for="jcc-cb">Owner</label>',
    '      <select id="jcc-cb" class="jcc-sel"><option value="all">All Owners</option></select>',
    '    </div>',
    '    <div class="jcc-fg"><label for="jcc-sk">Sort</label>',
    '      <select id="jcc-sk" class="jcc-sel">',
    '        <option value="lastModifiedAt">Last Modified</option>',
    '        <option value="createdAt">Created At</option>',
    '        <option value="name">Name</option>',
    '        <option value="status">Status</option>',
    '        <option value="aiScore">AI Score</option>',
    '      </select>',
    '      <button id="jcc-sd" class="jcc-dir-btn">&#x2191; Oldest</button>',
    '    </div>',
    '    <span id="jcc-rc" class="jcc-rc"></span>',
    '  </div>',
    '</div>',
    '<div id="jcc-eb" class="jcc-err-banner" style="display:none"></div>',
    // Table
    '<div class="jcc-tbl-wrap">',
    '  <table class="jcc-tbl"><thead><tr>',
    '    <th></th><th>Name</th><th>Status</th><th>Owner</th><th>Created</th><th>Stale</th><th>AI Score</th><th>Go</th>',
    '  </tr></thead><tbody id="jcc-tb"></tbody></table>',
    '  <div id="jcc-empty" class="jcc-empty" style="display:none"><p>&#x1F50D; No stale journeys match.</p></div>',
    '</div>',
    '<div id="jcc-pag" class="jcc-pag"></div>',
  ].join('');

  root.appendChild(dash);

  // Element refs
  const pw = dash.querySelector('#jcc-pw');
  const pf = dash.querySelector('#jcc-pf');
  const pl = dash.querySelector('#jcc-pl');
  const stopBtn = dash.querySelector('#jcc-stop');
  const tb = dash.querySelector('#jcc-tb');
  const emEl = dash.querySelector('#jcc-empty');
  const sqEl = dash.querySelector('#jcc-sq');
  const sqClr = dash.querySelector('#jcc-sq-clr');
  const sfEl = dash.querySelector('#jcc-sf');
  const cbEl = dash.querySelector('#jcc-cb');
  const skEl = dash.querySelector('#jcc-sk');
  const sdBtn = dash.querySelector('#jcc-sd');
  const rcEl = dash.querySelector('#jcc-rc');
  const pagEl = dash.querySelector('#jcc-pag');
  const errEl = dash.querySelector('#jcc-eb');
  const aiChk = dash.querySelector('#jcc-ai-chk');
  const aiCfg = dash.querySelector('#jcc-ai-cfg');
  const aiActions = dash.querySelector('#jcc-ai-actions');
  const aiUrlEl = dash.querySelector('#jcc-ai-url');
  const aiStatusEl = dash.querySelector('#jcc-ai-status');
  const aiHealthBtn = dash.querySelector('#jcc-ai-health-chk');
  const aiRunBtn = dash.querySelector('#jcc-ai-run');
  const aiStopBtn = dash.querySelector('#jcc-ai-stop');
  const aiBarBottom = dash.querySelector('#jcc-ai-bar-bottom');
  const aiPf = dash.querySelector('#jcc-ai-pf');
  const aiPl = dash.querySelector('#jcc-ai-pl');

  // ── summary ────────────────────────────────────────────────────────────────

  function updSummary() {
    const co = cutoff();
    const stale = all.filter((j) => new Date(j.metadata?.lastModifiedAt) < co && (j.status || '').toLowerCase() !== 'deployed');
    const cnt = (s) => stale.filter((j) => (j.status || '').toLowerCase() === s).length;
    dash.querySelector('#st').textContent = stale.length;
    dash.querySelector('#sd').textContent = cnt('draft');
    dash.querySelector('#sf').textContent = cnt('failed');
    dash.querySelector('#sc').textContent = cnt('closed') + cnt('stopped');
    const bCnt = (b) => stale.filter((j) => getBucket(daysAgo(j.metadata?.lastModifiedAt)) === b).length;
    dash.querySelector('#bk-0-30').textContent = bCnt('0-30');
    dash.querySelector('#bk-31-60').textContent = bCnt('31-60');
    dash.querySelector('#bk-61-90').textContent = bCnt('61-90');
    dash.querySelector('#bk-90plus').textContent = bCnt('90+');
  }

  function updOwnerFilter() {
    const co = cutoff();
    const stale = all.filter((j) => new Date(j.metadata?.lastModifiedAt) < co && (j.status || '').toLowerCase() !== 'deployed');
    const names = [...new Set(stale.map((j) => j.metadata?.createdBy || '').filter(Boolean))].sort();
    const prev = cbEl.value;
    cbEl.innerHTML = '<option value="all">All Owners</option>' + names.map((n) => `<option value="${esc(n)}"${n === prev ? ' selected' : ''}>${esc(n)}</option>`).join('');
  }

  // ── apply filters + sort ───────────────────────────────────────────────────

  function aiScore(id) {
    const e = aiScores.get(id);
    if (!e) return -1;
    const { rule, llm } = e;
    return llm && !llm.error ? Math.round(rule.score * 0.4 + (llm.retirementScore || 0) * 0.6) : rule.score;
  }

  function applyF() {
    const co = cutoff();
    const q = nameQ.toLowerCase();
    filtered = all.filter((j) => {
      if (!(new Date(j.metadata?.lastModifiedAt) < co)) return false;
      if ((j.status || '').toLowerCase() === 'deployed') return false;
      if (statusQ !== 'all' && (j.status || '').toLowerCase() !== statusQ) return false;
      if (createdByQ !== 'all' && (j.metadata?.createdBy || '') !== createdByQ) return false;
      if (bucketQ !== 'all' && getBucket(daysAgo(j.metadata?.lastModifiedAt)) !== bucketQ) return false;
      if (q) {
        const hay = [j.name, j.id, j.status, j.sandboxName, j.version, j.metadata?.createdBy, j.metadata?.lastModifiedBy].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      if (sortK === 'aiScore') {
        const sa = aiScore(a.id); const sb = aiScore(b.id);
        return sortD === 'asc' ? sb - sa : sa - sb; // desc = highest risk first
      }
      if (sortK === 'name') return sortD === 'asc' ? (a.name || '').localeCompare(b.name || '') : (b.name || '').localeCompare(a.name || '');
      if (sortK === 'status') return sortD === 'asc' ? (a.status || '').localeCompare(b.status || '') : (b.status || '').localeCompare(a.status || '');
      const ts = (j) => new Date(sortK === 'createdAt' ? j.metadata?.createdAt : j.metadata?.lastModifiedAt || 0).getTime();
      return sortD === 'asc' ? ts(a) - ts(b) : ts(b) - ts(a);
    });
    pg = 0;
    render();
  }

  // ── row detail ─────────────────────────────────────────────────────────────

  function mkDetail(j) {
    const sc = sClass(j.status);
    const days = daysAgo(j.metadata?.lastModifiedAt);
    const stCls = sc2(days);
    const dtr = document.createElement('tr');
    dtr.className = 'jcc-dtr';
    const journeyUrl = `https://experience.adobe.com/#/@${encodeURIComponent(cfg.tenantId)}/sname:${encodeURIComponent(cfg.sandbox)}/journey-optimizer/journeys/journey/${encodeURIComponent(j.id)}`;
    const fields = [
      ['Journey ID', `<span class="jcc-mono">${esc(j.id || '\u2014')}</span>`, j.id, true],
      ['IMS Org ID', `<span class="jcc-mono">${esc(j.imsOrgId || '\u2014')}</span>`, null, true],
      ['Name', esc(j.name || '\u2014'), null, false],
      ['Status', `<span class="jcc-st jcc-st-${sc}">${esc(j.status || '\u2014')}</span>`, null, false],
      ['Version', esc(j.version || '\u2014'), null, false],
      ['Sandbox', esc(j.sandboxName || '\u2014'), null, false],
      ['Created By', esc(j.metadata?.createdBy || '\u2014'), null, false],
      ['Created At', fmtDate(j.metadata?.createdAt), null, false],
      ['Last Modified By', esc(j.metadata?.lastModifiedBy || '\u2014'), null, false],
      ['Last Modified At', fmtDate(j.metadata?.lastModifiedAt), null, false],
      ['Days Stale', `<span class="jcc-stale-badge ${stCls}">${days} days</span>`, null, false],
    ];
    let grid = '<div class="jcc-dgrid">';
    fields.forEach(([lbl, val, copyv, full]) => {
      const fc = full ? ' jcc-df' : '';
      const cb = copyv ? `<button class="jcc-copy" data-v="${esc(copyv)}">&#x1F4CB;</button>` : '';
      grid += `<div class="jcc-di${fc}"><span class="jcc-dlbl">${lbl}</span><span class="jcc-dval">${val}</span>${cb}</div>`;
    });
    grid += '</div>';

    // AI detail panel
    const aiEntry = aiScores.get(j.id);
    const aiPendingRow = aiPending.has(j.id);
    let aiHtml = '';
    if (aiEnabled) {
      if (aiPendingRow) {
        aiHtml = '<div class="jcc-ai-detail"><div class="jcc-ai-detail-hdr"><span>&#x1F916;</span> AI Risk Analysis</div><div class="jcc-ai-analyzing">\u23F3 Analyzing\u2026</div></div>';
      } else if (aiEntry) {
        aiHtml = aiDetailHtml(aiEntry.rule, aiEntry.llm);
      } else {
        aiHtml = '<div class="jcc-ai-detail jcc-ai-detail-empty"><span>&#x1F916;</span> Click <em>Analyze All</em> to score this journey with AI.</div>';
      }
    }

    dtr.innerHTML = `<td colspan="8"><div class="jcc-dpanel">${grid}${aiHtml}</div></td>`;
    dtr.querySelectorAll('.jcc-copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        navigator.clipboard?.writeText(btn.dataset.v).then(() => {
          const orig = btn.textContent; btn.textContent = '\u2713';
          setTimeout(() => { btn.textContent = orig; }, 1500);
        });
      });
    });
    return dtr;
  }

  // ── render table ───────────────────────────────────────────────────────────

  function render() {
    const tot = filtered.length;
    const pages = Math.max(1, Math.ceil(tot / ROWS_PER_PAGE));
    if (pg >= pages) pg = pages - 1;
    const items = filtered.slice(pg * ROWS_PER_PAGE, (pg + 1) * ROWS_PER_PAGE);

    rcEl.textContent = loading
      ? `Loaded ${all.length} (fetching\u2026) \u2014 ${tot} shown`
      : `${tot} stale journey${tot !== 1 ? 's' : ''}${all.length !== tot ? ` of ${all.length}` : ''}`;

    tb.innerHTML = '';
    if (!items.length) {
      emEl.style.display = 'flex';
    } else {
      emEl.style.display = 'none';
      items.forEach((j) => {
        const sc = sClass(j.status);
        const days = daysAgo(j.metadata?.lastModifiedAt);
        const stCls = sc2(days);
        const isExp = expanded === j.id;
        const tr = document.createElement('tr');
        tr.className = `jcc-row${isExp ? ' jcc-row-exp' : ''}`;
        const journeyUrl = `https://experience.adobe.com/#/@${encodeURIComponent(cfg.tenantId)}/sname:${encodeURIComponent(cfg.sandbox)}/journey-optimizer/journeys/journey/${encodeURIComponent(j.id)}`;
        const aiEntry = aiScores.get(j.id);
        const pending = aiPending.has(j.id);
        const badge = scoreBadgeHtml(aiEntry?.rule || null, aiEntry?.llm || null, pending);
        tr.innerHTML = [
          `<td><button class="jcc-tog" aria-expanded="${isExp}">${isExp ? '\u25B2' : '\u25BC'}</button></td>`,
          `<td class="jcc-cn" title="${esc(j.name || '')}"><span>${esc(j.name || '\u2014')}</span>${isDefaultJourneyName(j.name) ? ' <span class="jcc-default-badge" title="AJO default name">default</span>' : ''}</td>`,
          `<td><span class="jcc-st jcc-st-${sc}">${esc(j.status || '\u2014')}</span></td>`,
          `<td class="jcc-cp" title="${esc(j.metadata?.createdBy || '')}">${esc(j.metadata?.createdBy || '\u2014')}</td>`,
          `<td class="jcc-cd">${fmtDate(j.metadata?.createdAt)}</td>`,
          `<td class="jcc-cs ${stCls}">${days}d</td>`,
          `<td class="jcc-cai">${badge}</td>`,
          `<td class="jcc-cgo"><a class="jcc-go-btn" href="${esc(journeyUrl)}" target="_blank" rel="noopener noreferrer">&#x1F517; Go</a></td>`,
        ].join('');
        tb.appendChild(tr);
        tr.querySelector('.jcc-tog').addEventListener('click', () => {
          expanded = expanded === j.id ? null : j.id;
          render();
        });
        if (isExp) tb.appendChild(mkDetail(j));
      });
    }
    renderPag(tot, pages);
  }

  // ── pagination ─────────────────────────────────────────────────────────────

  function renderPag(tot, pages) {
    pagEl.innerHTML = '';
    if (pages <= 1) return;
    const mkBtn = (lbl, tgt, dis, act) => {
      const b = document.createElement('button');
      b.className = `jcc-pb${act ? ' jcc-pb-a' : ''}`;
      b.textContent = lbl; b.disabled = dis;
      if (!dis) b.addEventListener('click', () => { pg = tgt; render(); dash.querySelector('.jcc-tbl-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      return b;
    };
    const mkDot = () => { const s = document.createElement('span'); s.className = 'jcc-pe'; s.textContent = '\u2026'; return s; };
    const info = document.createElement('span'); info.className = 'jcc-pi'; info.textContent = `Page ${pg + 1} / ${pages}  (${tot})`;
    pagEl.appendChild(info);
    const nav = document.createElement('div'); nav.className = 'jcc-pnav';
    nav.appendChild(mkBtn('\u00AB', 0, pg === 0, false));
    nav.appendChild(mkBtn('\u2039', pg - 1, pg === 0, false));
    const R = 2; const rs = Math.max(0, pg - R); const re = Math.min(pages - 1, pg + R);
    if (rs > 0) { nav.appendChild(mkBtn('1', 0, false, false)); if (rs > 1) nav.appendChild(mkDot()); }
    for (let i = rs; i <= re; i += 1) nav.appendChild(mkBtn(String(i + 1), i, false, i === pg));
    if (re < pages - 1) { if (re < pages - 2) nav.appendChild(mkDot()); nav.appendChild(mkBtn(String(pages), pages - 1, false, false)); }
    nav.appendChild(mkBtn('\u203A', pg + 1, pg >= pages - 1, false));
    nav.appendChild(mkBtn('\u00BB', pages - 1, pg >= pages - 1, false));
    pagEl.appendChild(nav);
  }

  // ── progress helpers ───────────────────────────────────────────────────────

  function setP(pct, lbl) { pf.style.width = `${Math.min(100, pct)}%`; pl.textContent = lbl; }
  function doneP() { pw.classList.add('jcc-pd'); setTimeout(() => { pw.style.display = 'none'; }, 600); }
  function showErr(msg) { errEl.style.display = 'block'; errEl.innerHTML = `\u26A0 ${esc(msg)}`; }

  // ── AI controls ────────────────────────────────────────────────────────────

  function updAiStatus(ok, msg) {
    aiStatusEl.className = `jcc-ai-status ${ok ? 'jcc-ai-s-ok' : 'jcc-ai-s-err'}`;
    aiStatusEl.textContent = `\u25CF ${msg}`;
  }

  async function testProxy() {
    aiStatusEl.className = 'jcc-ai-status jcc-ai-s-unknown';
    aiStatusEl.textContent = '\u25CF Checking\u2026';
    const health = await checkProxyHealth(proxyUrl);
    if (health.ok) {
      updAiStatus(true, `Connected \u2014 ${health.model || 'unknown model'}`);
      aiRunBtn.disabled = loading;
    } else {
      updAiStatus(false, `Offline: ${health.error || 'unreachable'}`);
      aiRunBtn.disabled = true;
    }
  }

  function startAI() {
    if (aiRunning) return;
    aiRunning = true;
    aiRunBtn.style.display = 'none';
    aiStopBtn.style.display = 'inline-flex';
    aiBarBottom.style.display = 'flex';
    aiPf.style.width = '0%';
    aiPl.textContent = 'Starting 4 agents\u2026';

    const co = cutoff();
    const targets = all.filter((j) => new Date(j.metadata?.lastModifiedAt) < co && (j.status || '').toLowerCase() !== 'deployed');

    // Mark all as pending
    targets.forEach((j) => { aiPending.add(j.id); });
    render();

    agentPool = createAgentPool({
      cfg, proxyUrl, detailCache,
      onScore(id, rule, llm) {
        aiPending.delete(id);
        aiScores.set(id, { rule, llm });
        // Refresh visible row score badge without full re-render
        const scoreCell = tb.querySelector(`tr[data-id="${CSS.escape(id)}"] .jcc-cai`);
        if (scoreCell) scoreCell.innerHTML = scoreBadgeHtml(rule, llm, false);
        else render(); // row may be on different page
      },
      onProgress({ done, total, retireCount, reviewCount, keepCount }) {
        const pct = Math.round((done / total) * 100);
        aiPf.style.width = `${pct}%`;
        aiPl.textContent = `\u1F916 Analyzing ${done}/${total} journeys\u2026`;
        dash.querySelector('#jcc-ai-retire').textContent = `\uD83D\uDD34 ${retireCount} Retire`;
        dash.querySelector('#jcc-ai-review').textContent = `\uD83D\uDFE1 ${reviewCount} Review`;
        dash.querySelector('#jcc-ai-keep').textContent = `\uD83D\uDFE2 ${keepCount} Keep`;
      },
      onComplete() {
        aiRunning = false;
        aiStopBtn.style.display = 'none';
        aiRunBtn.style.display = 'inline-flex';
        aiRunBtn.textContent = '\uD83E\uDD16 Re-analyze';
        aiPl.textContent = `Done \u2014 ${targets.length} journeys scored`;
        aiPf.style.width = '100%';
        render();
      },
    });
    agentPool.enqueue(targets);
  }

  // ── event wiring ───────────────────────────────────────────────────────────

  aiChk.addEventListener('change', () => {
    aiEnabled = aiChk.checked;
    aiCfg.style.display = aiEnabled ? '' : 'none';
    aiActions.style.display = aiEnabled ? '' : 'none';
    saveAiSettings({ enabled: aiEnabled, proxyUrl });
    if (aiEnabled) testProxy();
    render();
  });

  aiUrlEl.addEventListener('change', () => {
    proxyUrl = aiUrlEl.value.trim() || 'http://localhost:3001';
    saveAiSettings({ enabled: aiEnabled, proxyUrl });
  });

  aiHealthBtn.addEventListener('click', () => { proxyUrl = aiUrlEl.value.trim() || 'http://localhost:3001'; testProxy(); });
  aiRunBtn.addEventListener('click', startAI);
  aiStopBtn.addEventListener('click', () => {
    if (agentPool) { agentPool.stop(); agentPool = null; }
    aiRunning = false;
    aiPending.clear();
    aiStopBtn.style.display = 'none';
    aiRunBtn.style.display = 'inline-flex';
    aiPl.textContent = `Stopped \u2014 ${aiScores.size} scored so far`;
    render();
  });

  if (aiEnabled) testProxy();

  let sqT;
  sqEl.addEventListener('input', () => { clearTimeout(sqT); sqT = setTimeout(() => { nameQ = sqEl.value; sqClr.style.display = nameQ ? 'flex' : 'none'; applyF(); }, 250); });
  sqClr.addEventListener('click', () => { sqEl.value = ''; nameQ = ''; sqClr.style.display = 'none'; applyF(); });
  sfEl.addEventListener('change', () => { statusQ = sfEl.value; applyF(); });
  cbEl.addEventListener('change', () => { createdByQ = cbEl.value; applyF(); });
  skEl.addEventListener('change', () => { sortK = skEl.value; applyF(); });
  sdBtn.addEventListener('click', () => { sortD = sortD === 'asc' ? 'desc' : 'asc'; sdBtn.textContent = sortD === 'asc' ? '\u2191 Oldest' : '\u2193 Newest'; applyF(); });

  dash.querySelectorAll('.jcc-bucket-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      bucketQ = btn.dataset.bucket;
      dash.querySelectorAll('.jcc-bucket-btn').forEach((b) => b.classList.remove('jcc-bucket-active'));
      btn.classList.add('jcc-bucket-active');
      applyF();
    });
  });

  dash.querySelector('#jr-csv').addEventListener('click', () => triggerDownload(buildCsv(filtered, cfg), `journey-cleanup-filtered-${todayIso()}.csv`));
  dash.querySelector('#jr-csv-all').addEventListener('click', () => {
    const co = cutoff();
    const allStale = all.filter((j) => new Date(j.metadata?.lastModifiedAt) < co && (j.status || '').toLowerCase() !== 'deployed');
    triggerDownload(buildCsv(allStale, cfg), `journey-cleanup-all-${todayIso()}.csv`);
  });
  dash.querySelector('#jr-reconfig').addEventListener('click', () => { showModal((nc) => showDashboard(root, nc)); });
  const refBtn = dash.querySelector('#jr-refresh');
  refBtn.addEventListener('click', () => {
    all = []; filtered = []; loading = true;
    errEl.style.display = 'none';
    pw.style.display = ''; pw.classList.remove('jcc-pd'); pf.style.width = '0%';
    refBtn.disabled = true;
    aiScores.clear(); aiPending.clear();
    updSummary(); applyF(); startLoad();
  });

  // ── fetch controller ───────────────────────────────────────────────────────

  let fetchCtrl = null;

  stopBtn.addEventListener('click', () => {
    if (fetchCtrl) { fetchCtrl.abort(); fetchCtrl = null; }
    stopBtn.style.display = 'none'; loading = false; refBtn.disabled = false;
    setP(pf ? parseFloat(pf.style.width) || 0 : 0, `\u23F9 Stopped \u2014 ${all.length} loaded`);
    updSummary(); updOwnerFilter(); applyF();
    setTimeout(() => { pw.style.display = 'none'; }, 2000);
  });

  function startLoad() {
    let totalPages = 0;
    stopBtn.style.display = 'inline-flex';
    setP(5, 'Fetching page 1\u2026');
    fetchCtrl = fetchAll(
      cfg,
      (chunk, cumul, pageNum) => {
        totalPages = Math.max(totalPages, pageNum + 1);
        all = cumul;
        const pct = totalPages > 1 ? Math.min(90, Math.round((pageNum / totalPages) * 85) + 5) : 50;
        setP(pct, `Page ${pageNum + 1} \u2014 ${cumul.length} fetched\u2026`);
        updSummary(); updOwnerFilter(); applyF();
      },
      (err) => showErr(`Fetch error: ${err.message}`),
      (final) => {
        fetchCtrl = null; all = final; loading = false; refBtn.disabled = false;
        stopBtn.style.display = 'none';
        setP(100, `Done \u2014 ${final.length} journeys`);
        updSummary(); updOwnerFilter(); applyF(); doneP();
        if (aiEnabled) aiRunBtn.disabled = false;
      },
    );
  }

  startLoad();
}

// ─── pre-dashboard placeholder ────────────────────────────────────────────────

function showPreDash(root) {
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'jcc-pre-dash';
  wrap.innerHTML = '<span class="jcc-pre-icon">&#x1F9F9;</span>'
    + '<p style="font-size:1.1rem;font-weight:600;color:#2c2c2c;margin:0">Journey Cleanup Dashboard</p>'
    + '<p style="color:#6e6e6e;margin:0.25rem 0 1rem;font-size:0.9rem">No credentials configured.</p>'
    + '<button class="jcc-btn-primary jcc-pre-open-cfg">&#x2699;&#xFE0F; Configure Credentials</button>';
  root.appendChild(wrap);
  wrap.querySelector('.jcc-pre-open-cfg').addEventListener('click', () => { showModal((nc) => showDashboard(root, nc)); });
}

// ─── EDS entry point ─────────────────────────────────────────────────────────

function initApp(root) {
  const blockCfg = readCfg(root);
  const hasCfg = blockCfg.token && blockCfg.apiKey && blockCfg.orgId && blockCfg.sandbox;
  const saved = getSaved();
  const hasSaved = saved.token && saved.apiKey && saved.orgId && saved.sandbox;
  const cfg = hasCfg ? blockCfg : (hasSaved ? saved : null);
  if (cfg) { showDashboard(root, cfg); }
  else { showPreDash(root); showModal((nc) => showDashboard(root, nc)); }
}

export default function decorate(block) {
  block.innerHTML = '';
  initApp(block);
}
