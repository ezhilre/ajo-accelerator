import os

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'journey-cleanup-card.js')

js = """\
/* Journey Cleanup Dashboard - AJO stale journeys (30+ days) */
/* eslint-disable no-await-in-loop */

const AJO_BASE = 'https://platform.adobe.io/ajo/journey';
const PAGE_SIZE = 50;
const ROWS_PER_PAGE = 20;
const STALE_DAYS = 30;
const SESSION_KEY = 'jcc_cfg';

// --- pure helpers ---

function cutoff() {
  const d = new Date();
  d.setDate(d.getDate() - STALE_DAYS);
  return d;
}

function fmtDate(iso) {
  if (!iso) return '\\u2014';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function daysAgo(iso) {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function sClass(status) {
  const m = { live: 'live', draft: 'draft', failed: 'failed', closed: 'closed', stopped: 'stopped' };
  return m[(status || '').toLowerCase()] || 'unknown';
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sc2(days) {
  if (days > 90) return 'jcc-stale-critical';
  if (days > 60) return 'jcc-stale-warn';
  return 'jcc-stale-ok';
}

function staleBucket(days) {
  if (days <= 30) return '0\\u201330 days';
  if (days <= 60) return '31\\u201360 days';
  if (days <= 90) return '61\\u201390 days';
  return '90+ days';
}

function getSaved() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}'); } catch (_) { return {}; }
}

// --- API ---

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function apiGet(cfg, page) {
  const rawFilter = `status=draft,deployed,failed,stopped,closed&metadata.lastModifiedAt<${todayIso()}`;
  const url = `${AJO_BASE}?pageSize=${PAGE_SIZE}&page=${page}&filter=${encodeURIComponent(rawFilter)}`;
  // eslint-disable-next-line no-console
  console.log(`[JCC] GET page=${page} | filter: ${rawFilter} | url: ${url}`);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'x-api-key': cfg.apiKey,
      'x-gw-ims-org-id': cfg.orgId,
      'x-sandbox-name': cfg.sandbox,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // eslint-disable-next-line no-console
    console.error(`[JCC] API error page=${page} HTTP ${res.status}`, body);
    throw new Error(`HTTP ${res.status} \\u2013 ${res.statusText}${body ? `: ${body}` : ''}`);
  }
  const json = await res.json();
  // eslint-disable-next-line no-console
  console.log(`[JCC] page=${page} received ${(json.results || []).length} items | totalCount=${json.pagination?.totalCount ?? 'n/a'}`);
  return json;
}

async function fetchAll(cfg, onChunk, onErr, onDone) {
  const all = [];
  // eslint-disable-next-line no-console
  console.log('[JCC] fetchAll started');
  let data0;
  try {
    data0 = await apiGet(cfg, 0);
  } catch (e) {
    onErr(e);
    onDone([]);
    return;
  }
  const items0 = data0.results || [];
  const totalCount = data0.pagination?.totalCount ?? items0.length;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  // eslint-disable-next-line no-console
  console.log(`[JCC] totalCount=${totalCount} \\u2192 totalPages=${totalPages}`);
  if (items0.length) {
    all.push(...items0);
    onChunk([...items0], [...all], 0);
  }
  if (totalPages <= 1) {
    // eslint-disable-next-line no-console
    console.log('[JCC] Single page \\u2014 done.');
    onDone([...all]);
    return;
  }
  for (let page = 1; page < totalPages; page += 1) {
    let data;
    try {
      data = await apiGet(cfg, page);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[JCC] Fatal error at page=${page} \\u2014 aborting remaining ${totalPages - page} pages`);
      onErr(e);
      break;
    }
    const items = data.results || [];
    if (!items.length) {
      // eslint-disable-next-line no-console
      console.warn(`[JCC] page=${page} returned 0 items \\u2014 stopping early`);
      break;
    }
    all.push(...items);
    onChunk([...items], [...all], page);
    // eslint-disable-next-line no-console
    console.log(`[JCC] cumulative=${all.length} / ${totalCount}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[JCC] fetchAll complete \\u2014 ${all.length} total journeys`);
  onDone([...all]);
}

// --- modal overlay credential form ---

function showModal(onOk, onCancel) {
  document.querySelector('.jcc-modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'jcc-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'AJO API Credentials');
  const box = document.createElement('div');
  box.className = 'jcc-modal-box';
  const saved = getSaved();
  const tokenVal = esc(saved.token || '');
  const apiKeyVal = esc(saved.apiKey || '');
  const sandboxVal = esc(saved.sandbox || '');
  const orgIdVal = esc(saved.orgId || '');
  const tenantVal = esc(saved.tenantId || '');
  box.innerHTML = [
    '<div class="jcc-modal-header">',
    '  <span class="jcc-modal-icon">&#x1F9F9;</span>',
    '  <div>',
    '    <h2 class="jcc-modal-title">Journey Cleanup Dashboard</h2>',
    `    <p class="jcc-modal-sub">Enter your AJO API credentials to discover journeys stale for ${STALE_DAYS}+ days</p>`,
    '  </div>',
    '</div>',
    '<form class="jcc-modal-form" id="jcc-modal-form" novalidate>',
    '  <div class="jcc-field">',
    '    <label class="jcc-label" for="jcc-m-token">Access Token <span class="jcc-req">*</span></label>',
    `    <textarea id="jcc-m-token" name="token" rows="4" placeholder="Paste your Bearer access token here...">${tokenVal}</textarea>`,
    '    <span class="jcc-field-hint">From Adobe Developer Console or Admin Console</span>',
    '  </div>',
    '  <div class="jcc-modal-row">',
    '    <div class="jcc-field">',
    '      <label class="jcc-label" for="jcc-m-apikey">API Key (x-api-key) <span class="jcc-req">*</span></label>',
    `      <input id="jcc-m-apikey" name="apiKey" type="text" value="${apiKeyVal}" placeholder="e.g. e5b407a4..." />`,
    '    </div>',
    '    <div class="jcc-field">',
    '      <label class="jcc-label" for="jcc-m-sandbox">Sandbox Name <span class="jcc-req">*</span></label>',
    `      <input id="jcc-m-sandbox" name="sandbox" type="text" value="${sandboxVal}" placeholder="e.g. xlg-dev" />`,
    '    </div>',
    '  </div>',
    '  <div class="jcc-modal-row">',
    '    <div class="jcc-field">',
    '      <label class="jcc-label" for="jcc-m-org">IMS Org ID <span class="jcc-req">*</span></label>',
    `      <input id="jcc-m-org" name="orgId" type="text" value="${orgIdVal}" placeholder="e.g. 9E1005A5...@AdobeOrg" />`,
    '    </div>',
    '    <div class="jcc-field">',
    '      <label class="jcc-label" for="jcc-m-tenant">Tenant ID <span class="jcc-req">*</span></label>',
    `      <input id="jcc-m-tenant" name="tenantId" type="text" value="${tenantVal}" placeholder="e.g. adobe-corpnew" />`,
    '      <span class="jcc-field-hint">Used to construct Journey URLs (e.g. adobe-corpnew)</span>',
    '    </div>',
    '  </div>',
    '  <div class="jcc-modal-error" id="jcc-modal-err" style="display:none"></div>',
    '  <div class="jcc-modal-footer">',
    '    <p class="jcc-modal-note">&#x1F512; Stored in sessionStorage only &mdash; never persisted or sent anywhere except Adobe APIs.</p>',
    '    <div class="jcc-modal-actions">',
    '      <button type="button" class="jcc-btn-cancel jcc-modal-cancel">&#x2715; Cancel</button>',
    '      <button type="submit" class="jcc-btn-primary jcc-modal-submit">&#x1F680; Load Journeys</button>',
    '    </div>',
    '  </div>',
    '</form>',
  ].join('');
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  document.body.classList.add('jcc-no-scroll');
  setTimeout(() => { const ta = box.querySelector('textarea'); if (ta) ta.focus(); }, 80);
  const cancelBtn = box.querySelector('.jcc-modal-cancel');
  if (onCancel) {
    cancelBtn.addEventListener('click', () => { closeModal(); onCancel(); });
  } else {
    cancelBtn.style.display = 'none';
  }
  box.querySelector('#jcc-modal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const cfg = {
      token: (fd.get('token') || '').trim(),
      apiKey: (fd.get('apiKey') || '').trim(),
      orgId: (fd.get('orgId') || '').trim(),
      sandbox: (fd.get('sandbox') || '').trim(),
      tenantId: (fd.get('tenantId') || '').trim(),
    };
    const errEl = box.querySelector('#jcc-modal-err');
    const missing = ['token', 'apiKey', 'orgId', 'sandbox', 'tenantId'].filter((k) => !cfg[k]);
    if (missing.length) {
      errEl.style.display = 'flex';
      errEl.textContent = `\\u26A0 Please fill in: ${missing.join(', ')}`;
      return;
    }
    errEl.style.display = 'none';
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(cfg));
    closeModal();
    onOk(cfg);
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && onCancel) { closeModal(); onCancel(); return; }
    if (e.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll('button,input,textarea,select,[tabindex]')]
      .filter((el) => !el.disabled && el.style.display !== 'none');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  });
}

function closeModal() {
  document.querySelector('.jcc-modal-overlay')?.remove();
  document.body.classList.remove('jcc-no-scroll');
}

// --- read EDS block config ---

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

// --- journey URL builder ---

function buildJourneyUrl(cfg, journeyId) {
  const tenant = encodeURIComponent(cfg.tenantId || '');
  const sandbox = encodeURIComponent(cfg.sandbox || '');
  return `https://experience.adobe.com/#/@${tenant}/sname:${sandbox}/journey-optimizer/journeys/journey/${journeyId}`;
}

// --- CSV helpers ---

function csvCell(v) {
  const s = String(v == null ? '' : v);
  if (s.includes(',') || s.includes('"') || s.includes('\\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsvRow(cols) {
  return cols.map(csvCell).join(',');
}

function downloadCsv(rows, filename) {
  const hdrs = ['Name', 'ID', 'Status', 'Version', 'Sandbox', 'Created By', 'Created At',
    'Last Modified By', 'Last Modified At', 'Days Stale', 'Bucket', 'Journey URL'];
  const lines = [toCsvRow(hdrs), ...rows];
  const blob = new Blob([lines.join('\\r\\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function journeyToCsvRow(j, cfg) {
  const days = daysAgo(j.metadata?.lastModifiedAt);
  return toCsvRow([
    j.name || '',
    j.id || '',
    j.status || '',
    j.version || '',
    j.sandboxName || '',
    j.metadata?.createdBy || '',
    fmtDate(j.metadata?.createdAt),
    j.metadata?.lastModifiedBy || '',
    fmtDate(j.metadata?.lastModifiedAt),
    days,
    staleBucket(days),
    buildJourneyUrl(cfg, j.id),
  ]);
}

// --- dashboard ---

function showDashboard(root, cfg) {
  let all = [];
  let filtered = [];
  let pg = 0;
  let nameQ = '';
  let statusQ = 'all';
  let createdByQ = 'all';
  let bucketQ = 'all';
  let sortK = 'lastModifiedAt';
  let sortD = 'asc';
  let loading = true;
  let expanded = null;

  root.innerHTML = '';
  const dash = document.createElement('div');
  dash.className = 'jcc-dashboard';

  dash.innerHTML = [
    '<div class="jcc-header">',
    '  <div class="jcc-header-left">',
    '    <span class="jcc-hi">&#x1F9F9;</span>',
    '    <div>',
    '      <h2 class="jcc-title">Journey Cleanup Dashboard</h2>',
    `      <p class="jcc-sub">Journeys not modified in <strong>${STALE_DAYS}+ days</strong></p>`,
    '    </div>',
    '  </div>',
    '  <div class="jcc-header-right">',
    `    <span class="jcc-sandbox-badge">${esc(cfg.sandbox)}</span>`,
    '    <button class="jcc-btn-sec" id="jr-csv-all">&#x1F4E5; Download All CSV</button>',
    '    <button class="jcc-btn-sec" id="jr-csv">&#x1F4E5; Export Filtered CSV</button>',
    '    <button class="jcc-btn-sec" id="jr-reconfig">&#x2699; Reconfigure</button>',
    '    <button class="jcc-btn-pri" id="jr-refresh" disabled>&#x21BA; Refresh</button>',
    '  </div>',
    '</div>',
    '<div class="jcc-summary">',
    '  <div class="jcc-sc jcc-sc-total"><span class="jcc-sn" id="st">&#x2014;</span><span class="jcc-sl">Total Stale</span></div>',
    '  <div class="jcc-sc jcc-sc-live"><span class="jcc-sn" id="sl">&#x2014;</span><span class="jcc-sl">Live</span></div>',
    '  <div class="jcc-sc jcc-sc-draft"><span class="jcc-sn" id="sd">&#x2014;</span><span class="jcc-sl">Draft</span></div>',
    '  <div class="jcc-sc jcc-sc-failed"><span class="jcc-sn" id="sf">&#x2014;</span><span class="jcc-sl">Failed</span></div>',
    '  <div class="jcc-sc jcc-sc-closed"><span class="jcc-sn" id="sc">&#x2014;</span><span class="jcc-sl">Closed/Stopped</span></div>',
    '</div>',
    '<div class="jcc-buckets" id="jcc-buckets">',
    '  <button class="jcc-bucket jcc-bucket-active" data-bucket="all">All</button>',
    '  <button class="jcc-bucket" data-bucket="0\\u201330 days">0\\u201330 days</button>',
    '  <button class="jcc-bucket" data-bucket="31\\u201360 days">31\\u201360 days</button>',
    '  <button class="jcc-bucket" data-bucket="61\\u201390 days">61\\u201390 days</button>',
    '  <button class="jcc-bucket" data-bucket="90+ days">90+ days</button>',
    '</div>',
    '<div class="jcc-prog-wrap" id="jcc-pw">',
    '  <div class="jcc-prog-track"><div class="jcc-prog-fill" id="jcc-pf"></div></div>',
    '  <span class="jcc-prog-lbl" id="jcc-pl">Starting...</span>',
    '</div>',
    '<div class="jcc-controls">',
    '  <div class="jcc-search-wrap">',
    '    <span>&#x1F50D;</span>',
    '    <input id="jcc-sq" class="jcc-search" type="text" placeholder="Search name, ID, owner, sandbox..." autocomplete="off" />',
    '    <button id="jcc-sq-clr" class="jcc-clr-btn" title="Clear">&#x2715;</button>',
    '  </div>',
    '  <div class="jcc-filter-row">',
    '    <div class="jcc-fg">',
    '      <label for="jcc-sf">Status</label>',
    '      <select id="jcc-sf" class="jcc-sel">',
    '        <option value="all">All</option>',
    '        <option value="live">Live</option>',
    '        <option value="draft">Draft</option>',
    '        <option value="failed">Failed</option>',
    '        <option value="closed">Closed</option>',
    '        <option value="stopped">Stopped</option>',
    '      </select>',
    '    </div>',
    '    <div class="jcc-fg">',
    '      <label for="jcc-cb">Created By</label>',
    '      <select id="jcc-cb" class="jcc-sel"><option value="all">All Owners</option></select>',
    '    </div>',
    '    <div class="jcc-fg">',
    '      <label for="jcc-sk">Sort by</label>',
    '      <select id="jcc-sk" class="jcc-sel">',
    '        <option value="lastModifiedAt">Last Modified</option>',
    '        <option value="createdAt">Created At</option>',
    '        <option value="name">Name</option>',
    '        <option value="status">Status</option>',
    '      </select>',
    '      <button id="jcc-sd" class="jcc-dir-btn">&#x2191; Oldest</button>',
    '    </div>',
    '    <span id="jcc-rc" class="jcc-rc"></span>',
    '  </div>',
    '</div>',
    '<div id="jcc-eb" class="jcc-err-banner" style="display:none"></div>',
    '<div class="jcc-tbl-wrap">',
    '  <table class="jcc-tbl">',
    '    <thead><tr>',
    '      <th></th><th>Name</th><th>Status</th>',
    '      <th>Created By</th><th>Created At</th>',
    '      <th>Stale</th><th>Bucket</th><th>Go</th>',
    '    </tr></thead>',
    '    <tbody id="jcc-tb"></tbody>',
    '  </table>',
    '  <div id="jcc-empty" class="jcc-empty" style="display:none">',
    '    <p>&#x1F50D; No stale journeys match the current filters.</p>',
    '  </div>',
    '</div>',
    '<div id="jcc-pag" class="jcc-pag"></div>',
  ].join('');

  root.appendChild(dash);

  const pw = dash.querySelector('#jcc-pw');
  const pf = dash.querySelector('#jcc-pf');
  const pl = dash.querySelector('#jcc-pl');
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
  const reconfigBtn = dash.querySelector('#jr-reconfig');
  const refBtn = dash.querySelector('#jr-refresh');
  const bucketsEl = dash.querySelector('#jcc-buckets');

  function updSummary() {
    const co = cutoff();
    const stale = all.filter((j) => new Date(j.metadata?.lastModifiedAt) < co);
    const cnt = (s) => stale.filter((j) => (j.status || '').toLowerCase() === s).length;
    dash.querySelector('#st').textContent = stale.length;
    dash.querySelector('#sl').textContent = cnt('deployed');
    dash.querySelector('#sd').textContent = cnt('draft');
    dash.querySelector('#sf').textContent = cnt('failed');
    dash.querySelector('#sc').textContent = cnt('closed') + cnt('stopped');
    const buckets = { all: stale.length };
    stale.forEach((j) => {
      const b = staleBucket(daysAgo(j.metadata?.lastModifiedAt));
      buckets[b] = (buckets[b] || 0) + 1;
    });
    bucketsEl.querySelectorAll('.jcc-bucket').forEach((btn) => {
      const b = btn.dataset.bucket;
      const count = buckets[b] || 0;
      btn.textContent = b === 'all' ? `All (${stale.length})` : `${b} (${count})`;
    });
  }

  function updCreatedByFilter() {
    const co = cutoff();
    const stale = all.filter((j) => new Date(j.metadata?.lastModifiedAt) < co);
    const names = [...new Set(stale.map((j) => j.metadata?.createdBy || '').filter(Boolean))].sort();
    const prev = cbEl.value;
    cbEl.innerHTML = '<option value="all">All Owners</option>'
      + names.map((n) => `<option value="${esc(n)}"${n === prev ? ' selected' : ''}>${esc(n)}</option>`).join('');
  }

  function applyF() {
    const co = cutoff();
    const q = nameQ.toLowerCase();
    filtered = all.filter((j) => {
      if (!(new Date(j.metadata?.lastModifiedAt) < co)) return false;
      const apiStatus = statusQ === 'live' ? 'deployed' : statusQ;
      if (apiStatus !== 'all' && (j.status || '').toLowerCase() !== apiStatus) return false;
      if (createdByQ !== 'all' && (j.metadata?.createdBy || '') !== createdByQ) return false;
      if (bucketQ !== 'all' && staleBucket(daysAgo(j.metadata?.lastModifiedAt)) !== bucketQ) return false;
      if (q) {
        const hay = [j.name, j.id, j.status, j.sandboxName, j.version,
          j.metadata?.createdBy, j.metadata?.lastModifiedBy].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    filtered.sort((a, b) => {
      if (sortK === 'name') {
        return sortD === 'asc'
          ? (a.name || '').localeCompare(b.name || '')
          : (b.name || '').localeCompare(a.name || '');
      }
      if (sortK === 'status') {
        return sortD === 'asc'
          ? (a.status || '').localeCompare(b.status || '')
          : (b.status || '').localeCompare(a.status || '');
      }
      const ts = (j) => new Date(
        sortK === 'createdAt' ? j.metadata?.createdAt : j.metadata?.lastModifiedAt || 0,
      ).getTime();
      return sortD === 'asc' ? ts(a) - ts(b) : ts(b) - ts(a);
    });
    pg = 0;
    render();
  }

  function mkDetail(j) {
    const sc = sClass(j.status);
    const days = daysAgo(j.metadata?.lastModifiedAt);
    const stCls = sc2(days);
    const dtr = document.createElement('tr');
    dtr.className = 'jcc-dtr';
    const journeyUrl = buildJourneyUrl(cfg, j.id);
    const detailRows = [
      ['Journey ID', `<span class="jcc-mono">${esc(j.id || '\\u2014')}</span>`, j.id, true],
      ['IMS Org ID', `<span class="jcc-mono">${esc(j.imsOrgId || '\\u2014')}</span>`, null, true],
      ['Name', esc(j.name || '\\u2014'), null, false],
      ['Status', `<span class="jcc-st jcc-st-${sc}">${esc(j.status || '\\u2014')}</span>`, null, false],
      ['Version', esc(j.version || '\\u2014'), null, false],
      ['Sandbox', esc(j.sandboxName || '\\u2014'), null, false],
      ['Created By', esc(j.metadata?.createdBy || '\\u2014'), null, false],
      ['Creator ID', `<span class="jcc-mono jcc-sm">${esc(j.metadata?.createdById || '\\u2014')}</span>`, null, false],
      ['Created At', fmtDate(j.metadata?.createdAt), null, false],
      ['Last Modified By', esc(j.metadata?.lastModifiedBy || '\\u2014'), null, false],
      ['Modifier ID', `<span class="jcc-mono jcc-sm">${esc(j.metadata?.lastModifiedById || '\\u2014')}</span>`, null, false],
      ['Last Modified At', fmtDate(j.metadata?.lastModifiedAt), null, false],
      ['Days Stale', `<span class="jcc-stale-badge ${stCls}">${days} days</span>`, null, false],
      ['Bucket', `<span class="jcc
