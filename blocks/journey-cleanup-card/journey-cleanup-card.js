/* Journey Cleanup Dashboard - AJO stale journeys (30+ days) */
/* eslint-disable no-await-in-loop */

const AJO_BASE = 'https://platform.adobe.io/ajo/journey';
const PAGE_SIZE = 50;
const ROWS_PER_PAGE = 20;
const STALE_DAYS = 30;
const SESSION_KEY = 'jcc_cfg';

// ─── pure helpers ────────────────────────────────────────────────────────────

function cutoff() {
  const d = new Date();
  d.setDate(d.getDate() - STALE_DAYS);
  return d;
}

function fmtDate(iso) {
  if (!iso) return '\u2014';
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

function getSaved() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}'); } catch (_) { return {}; }
}

// ─── API ─────────────────────────────────────────────────────────────────────

// Today's date as "YYYY-MM-DD"
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Single page fetch.
// Filter: status=draft,failed,stopped,closed&metadata.lastModifiedAt<TODAY
// Excludes "deployed" (Live) journeys intentionally.
async function apiGet(cfg, page, signal) {
  const rawFilter = `status=draft,failed,stopped,closed&metadata.lastModifiedAt<${todayIso()}`;
  const url = `${AJO_BASE}?pageSize=${PAGE_SIZE}&page=${page}&filter=${encodeURIComponent(rawFilter)}`;
  // eslint-disable-next-line no-console
  console.log(`[JCC] GET page=${page} | filter: ${rawFilter} | url: ${url}`);
  const res = await fetch(url, {
    signal,
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
    throw new Error(`HTTP ${res.status} – ${res.statusText}${body ? `: ${body}` : ''}`);
  }
  const json = await res.json();
  // eslint-disable-next-line no-console
  console.log(`[JCC] page=${page} received ${(json.results || []).length} items | totalCount=${json.pagination?.totalCount ?? 'n/a'}`);
  return json;
}

// Fetch all pages sequentially.
// Page 0 reveals pagination.totalCount → compute total pages → fetch 1…N.
// Stops immediately on any HTTP error.
// Returns the AbortController so callers can cancel mid-flight.
function fetchAll(cfg, onChunk, onErr, onDone) {
  const controller = new AbortController();
  const { signal } = controller;

  (async () => {
  const all = [];
  // eslint-disable-next-line no-console
  console.log('[JCC] fetchAll started');

  // ── page 0 (bootstrap) ──────────────────────────────────────────────────
  let data0;
  try {
    data0 = await apiGet(cfg, 0, signal);
  } catch (e) {
    if (e.name === 'AbortError') { onDone([...all]); return; }
    onErr(e);
    onDone([]);
    return;
  }

  const items0 = data0.results || [];
  const totalCount = data0.pagination?.totalCount ?? items0.length;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  // eslint-disable-next-line no-console
  console.log(`[JCC] totalCount=${totalCount} → totalPages=${totalPages}`);

  if (items0.length) {
    all.push(...items0);
    onChunk([...items0], [...all], 0);
  }

  if (totalPages <= 1) {
    // eslint-disable-next-line no-console
    console.log('[JCC] Single page — done.');
    onDone([...all]);
    return;
  }

  // ── pages 1 … totalPages-1 ──────────────────────────────────────────────
  for (let page = 1; page < totalPages; page += 1) {
    if (signal.aborted) break;
    let data;
    try {
      data = await apiGet(cfg, page, signal);
    } catch (e) {
      if (e.name === 'AbortError') break;
      // eslint-disable-next-line no-console
      console.error(`[JCC] Fatal error at page=${page} — aborting remaining ${totalPages - page} pages`);
      onErr(e);
      break;
    }

    const items = data.results || [];
    if (!items.length) {
      // eslint-disable-next-line no-console
      console.warn(`[JCC] page=${page} returned 0 items — stopping early`);
      break;
    }

    all.push(...items);
    onChunk([...items], [...all], page);
    // eslint-disable-next-line no-console
    console.log(`[JCC] cumulative=${all.length} / ${totalCount}`);
  }

  // eslint-disable-next-line no-console
  console.log(`[JCC] fetchAll complete — ${all.length} total journeys`);
  onDone([...all]);
  })();

  return controller;
}

// ─── modal overlay credential form ───────────────────────────────────────────

function showModal(onOk) {
  // remove any existing modal
  document.querySelector('.jcc-modal-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'jcc-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'AJO API Credentials');

  const box = document.createElement('div');
  box.className = 'jcc-modal-box';

  const saved = getSaved();

  box.innerHTML = ''
    + '<div class="jcc-modal-header">'
    + '  <span class="jcc-modal-icon">&#x1F9F9;</span>'
    + '  <div>'
    + '    <h2 class="jcc-modal-title">Journey Cleanup Dashboard</h2>'
    + `    <p class="jcc-modal-sub">Enter your AJO API credentials to discover journeys stale for ${STALE_DAYS}+ days</p>`
    + '  </div>'
    + '</div>'
    + '<form class="jcc-modal-form" id="jcc-modal-form" novalidate>'
    + '  <div class="jcc-field">'
    + '    <label class="jcc-label" for="jcc-m-token">Access Token <span class="jcc-req">*</span></label>'
    + '    <textarea id="jcc-m-token" name="token" rows="4"'
    + `      placeholder="Paste your Bearer access token here...">${esc(saved.token || '')}</textarea>`
    + '    <span class="jcc-field-hint">From Adobe Developer Console or Admin Console</span>'
    + '  </div>'
    + '  <div class="jcc-modal-row">'
    + '    <div class="jcc-field">'
    + '      <label class="jcc-label" for="jcc-m-apikey">API Key (x-api-key) <span class="jcc-req">*</span></label>'
    + `      <input id="jcc-m-apikey" name="apiKey" type="text" value="${esc(saved.apiKey || '')}" placeholder="Your API Key" />`
    + '    </div>'
    + '    <div class="jcc-field">'
    + '      <label class="jcc-label" for="jcc-m-sandbox">Sandbox Name <span class="jcc-req">*</span></label>'
    + `      <input id="jcc-m-sandbox" name="sandbox" type="text" value="${esc(saved.sandbox || '')}" placeholder="Sandbox name" />`
    + '    </div>'
    + '  </div>'
    + '  <div class="jcc-field">'
    + '    <label class="jcc-label" for="jcc-m-org">IMS Org ID <span class="jcc-req">*</span></label>'
    + `    <input id="jcc-m-org" name="orgId" type="text" value="${esc(saved.orgId || '')}" placeholder="IMS Org ID" />`
    + '  </div>'
    + '  <div class="jcc-field">'
    + '    <label class="jcc-label" for="jcc-m-tenant">Tenant ID <span class="jcc-req">*</span></label>'
    + `    <input id="jcc-m-tenant" name="tenantId" type="text" value="${esc(saved.tenantId || '')}" placeholder="Tenant ID" />`
    + '    <span class="jcc-field-hint">Your Adobe Experience Platform tenant identifier</span>'
    + '  </div>'
    + '  <div class="jcc-modal-error" id="jcc-modal-err" style="display:none"></div>'
    + '  <div class="jcc-modal-footer">'
    + '    <p class="jcc-modal-note">&#x1F512; Stored in sessionStorage only &mdash; never persisted or sent anywhere except Adobe APIs.</p>'
    + '    <div class="jcc-modal-actions">'
    + '      <button type="button" class="jcc-btn-secondary jcc-modal-cancel">&#x2715; Cancel</button>'
    + '      <button type="submit" class="jcc-btn-primary jcc-modal-submit">&#x1F680; Load Journeys</button>'
    + '    </div>'
    + '  </div>'
    + '</form>';

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // prevent background scroll
  document.body.classList.add('jcc-no-scroll');

  // focus first field
  setTimeout(() => {
    const ta = box.querySelector('textarea');
    if (ta) ta.focus();
  }, 80);

  // submit
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
      errEl.textContent = `\u26A0 Please fill in: ${missing.join(', ')}`;
      return;
    }
    errEl.style.display = 'none';
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(cfg));
    closeModal();
    onOk(cfg);
  });

  // cancel button — close modal without saving
  const cancelBtn = box.querySelector('.jcc-modal-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      closeModal();
    });
  }

  // trap focus inside modal
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll('button,input,textarea,select,[tabindex]')].filter((el) => !el.disabled);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

function closeModal() {
  document.querySelector('.jcc-modal-overlay')?.remove();
  document.body.classList.remove('jcc-no-scroll');
}

// ─── read EDS block config ────────────────────────────────────────────────────

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
  });
  return cfg;
}

// ─── dashboard ────────────────────────────────────────────────────────────────

// Returns the bucket key for a given number of days stale
function getBucket(days) {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

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
  dash.innerHTML = ''
    + '<div class="jcc-header">'
    + '  <div class="jcc-header-left">'
    + '    <span class="jcc-hi">&#x1F9F9;</span>'
    + '    <div>'
    + '      <h2 class="jcc-title">Journey Cleanup Dashboard</h2>'
    + `      <p class="jcc-sub">Journeys not modified in <strong>${STALE_DAYS}+ days</strong></p>`
    + '    </div>'
    + '  </div>'
    + '  <div class="jcc-header-right">'
    + `    <span class="jcc-sandbox-badge">${esc(cfg.sandbox)}</span>`
    + '    <button class="jcc-btn-sec" id="jr-csv-all">&#x1F4E5; Download All CSV</button>'
    + '    <button class="jcc-btn-sec" id="jr-csv">&#x1F4E5; Export Filtered CSV</button>'
    + '    <button class="jcc-btn-sec" id="jr-reconfig">&#x2699; Reconfigure</button>'
    + '    <button class="jcc-btn-pri" id="jr-refresh" disabled>&#x21BA; Refresh</button>'
    + '  </div>'
    + '</div>'
    + '<div class="jcc-summary">'
    + '  <div class="jcc-sc jcc-sc-total"><span class="jcc-sn" id="st">&#x2014;</span><span class="jcc-sl">Total</span></div>'
    + '  <div class="jcc-sc jcc-sc-draft"><span class="jcc-sn" id="sd">&#x2014;</span><span class="jcc-sl">Draft</span></div>'
    + '  <div class="jcc-sc jcc-sc-failed"><span class="jcc-sn" id="sf">&#x2014;</span><span class="jcc-sl">Failed</span></div>'
    + '  <div class="jcc-sc jcc-sc-closed"><span class="jcc-sn" id="sc">&#x2014;</span><span class="jcc-sl">Closed/Stopped</span></div>'
    + '</div>'
    + '<div class="jcc-buckets">'
    + '  <span class="jcc-buckets-lbl">Age Buckets:</span>'
    + '  <button class="jcc-bucket-btn jcc-bucket-all jcc-bucket-active" data-bucket="all">All</button>'
    + '  <button class="jcc-bucket-btn jcc-bucket-0-30" data-bucket="0-30">0&#x2013;30 days</button>'
    + '  <button class="jcc-bucket-btn jcc-bucket-31-60" data-bucket="31-60">31&#x2013;60 days</button>'
    + '  <button class="jcc-bucket-btn jcc-bucket-61-90" data-bucket="61-90">61&#x2013;90 days</button>'
    + '  <button class="jcc-bucket-btn jcc-bucket-90plus" data-bucket="90+">90+ days</button>'
    + '  <span class="jcc-bucket-counts">'
    + '    <span class="jcc-bc-item jcc-bc-0-30">0&#x2013;30: <strong id="bk-0-30">&#x2014;</strong></span>'
    + '    <span class="jcc-bc-item jcc-bc-31-60">31&#x2013;60: <strong id="bk-31-60">&#x2014;</strong></span>'
    + '    <span class="jcc-bc-item jcc-bc-61-90">61&#x2013;90: <strong id="bk-61-90">&#x2014;</strong></span>'
    + '    <span class="jcc-bc-item jcc-bc-90plus">90+: <strong id="bk-90plus">&#x2014;</strong></span>'
    + '  </span>'
    + '</div>'
    + '<div class="jcc-prog-wrap" id="jcc-pw">'
    + '  <div class="jcc-prog-track"><div class="jcc-prog-fill" id="jcc-pf"></div></div>'
    + '  <span class="jcc-prog-lbl" id="jcc-pl">Starting...</span>'
    + '  <button class="jcc-stop-btn" id="jcc-stop" title="Stop fetching">&#x23F9; Stop</button>'
    + '</div>'
    + '<div class="jcc-controls">'
    + '  <div class="jcc-search-wrap">'
    + '    <span>&#x1F50D;</span>'
    + '    <input id="jcc-sq" class="jcc-search" type="text" placeholder="Search name, ID, owner, sandbox..." autocomplete="off" />'
    + '    <button id="jcc-sq-clr" class="jcc-clr-btn" title="Clear">&#x2715;</button>'
    + '  </div>'
    + '  <div class="jcc-filter-row">'
    + '    <div class="jcc-fg">'
    + '      <label for="jcc-sf">Status</label>'
    + '      <select id="jcc-sf" class="jcc-sel">'
    + '        <option value="all">All</option>'
    + '        <option value="draft">Draft</option>'
    + '        <option value="failed">Failed</option>'
    + '        <option value="closed">Closed</option>'
    + '        <option value="stopped">Stopped</option>'
    + '      </select>'
    + '    </div>'
    + '    <div class="jcc-fg">'
    + '      <label for="jcc-cb">Created By</label>'
    + '      <select id="jcc-cb" class="jcc-sel">'
    + '        <option value="all">All Owners</option>'
    + '      </select>'
    + '    </div>'
    + '    <div class="jcc-fg">'
    + '      <label for="jcc-sk">Sort by</label>'
    + '      <select id="jcc-sk" class="jcc-sel">'
    + '        <option value="lastModifiedAt">Last Modified</option>'
    + '        <option value="createdAt">Created At</option>'
    + '        <option value="name">Name</option>'
    + '        <option value="status">Status</option>'
    + '      </select>'
    + '      <button id="jcc-sd" class="jcc-dir-btn">&#x2191; Oldest</button>'
    + '    </div>'
    + '    <span id="jcc-rc" class="jcc-rc"></span>'
    + '  </div>'
    + '</div>'
    + '<div id="jcc-eb" class="jcc-err-banner" style="display:none"></div>'
    + '<div class="jcc-tbl-wrap">'
    + '  <table class="jcc-tbl">'
    + '    <thead><tr>'
    + '      <th></th><th>Name</th><th>Status</th>'
    + '      <th>Created By</th><th>Created At</th>'
    + '      <th>Stale</th><th>Go</th>'
    + '    </tr></thead>'
    + '    <tbody id="jcc-tb"></tbody>'
    + '  </table>'
    + '  <div id="jcc-empty" class="jcc-empty" style="display:none">'
    + '    <p>&#x1F50D; No stale journeys match the current filters.</p>'
    + '  </div>'
    + '</div>'
    + '<div id="jcc-pag" class="jcc-pag"></div>';

  root.appendChild(dash);

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
  const reconfigBtn = dash.querySelector('#jr-reconfig');
  const refBtn = dash.querySelector('#jr-refresh');

  function updSummary() {
    const co = cutoff();
    // Exclude deployed (Live) journeys from all counts
    const stale = all.filter((j) => new Date(j.metadata?.lastModifiedAt) < co
      && (j.status || '').toLowerCase() !== 'deployed');
    const cnt = (s) => stale.filter((j) => (j.status || '').toLowerCase() === s).length;
    dash.querySelector('#st').textContent = stale.length;
    dash.querySelector('#sd').textContent = cnt('draft');
    dash.querySelector('#sf').textContent = cnt('failed');
    dash.querySelector('#sc').textContent = cnt('closed') + cnt('stopped');

    // Update bucket counts
    const bCnt = (b) => stale.filter((j) => getBucket(daysAgo(j.metadata?.lastModifiedAt)) === b).length;
    dash.querySelector('#bk-0-30').textContent = bCnt('0-30');
    dash.querySelector('#bk-31-60').textContent = bCnt('31-60');
    dash.querySelector('#bk-61-90').textContent = bCnt('61-90');
    dash.querySelector('#bk-90plus').textContent = bCnt('90+');
  }

  // Rebuild the "Created By" dropdown from current data
  function updCreatedByFilter() {
    const co = cutoff();
    const stale = all.filter((j) => new Date(j.metadata?.lastModifiedAt) < co
      && (j.status || '').toLowerCase() !== 'deployed');
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
      // Always exclude live (deployed) journeys
      if ((j.status || '').toLowerCase() === 'deployed') return false;
      if (statusQ !== 'all' && (j.status || '').toLowerCase() !== statusQ) return false;
      if (createdByQ !== 'all' && (j.metadata?.createdBy || '') !== createdByQ) return false;
      if (bucketQ !== 'all' && getBucket(daysAgo(j.metadata?.lastModifiedAt)) !== bucketQ) return false;
      if (q) {
        const hay = [j.name, j.id, j.status, j.sandboxName, j.version,
          j.metadata?.createdBy, j.metadata?.lastModifiedBy].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    filtered.sort((a, b) => {
      if (sortK === 'name') {
        return sortD === 'asc' ? (a.name || '').localeCompare(b.name || '') : (b.name || '').localeCompare(a.name || '');
      }
      if (sortK === 'status') {
        return sortD === 'asc' ? (a.status || '').localeCompare(b.status || '') : (b.status || '').localeCompare(a.status || '');
      }
      const ts = (j) => new Date(sortK === 'createdAt' ? j.metadata?.createdAt : j.metadata?.lastModifiedAt || 0).getTime();
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
    const rows = [
      ['Journey ID', `<span class="jcc-mono">${esc(j.id || '\u2014')}</span>`, j.id, true],
      ['IMS Org ID', `<span class="jcc-mono">${esc(j.imsOrgId || '\u2014')}</span>`, null, true],
      ['Name', esc(j.name || '\u2014'), null, false],
      ['Status', `<span class="jcc-st jcc-st-${sc}">${esc(j.status || '\u2014')}</span>`, null, false],
      ['Version', esc(j.version || '\u2014'), null, false],
      ['Sandbox', esc(j.sandboxName || '\u2014'), null, false],
      ['Created By', esc(j.metadata?.createdBy || '\u2014'), null, false],
      ['Creator ID', `<span class="jcc-mono jcc-sm">${esc(j.metadata?.createdById || '\u2014')}</span>`, null, false],
      ['Created At', fmtDate(j.metadata?.createdAt), null, false],
      ['Last Modified By', esc(j.metadata?.lastModifiedBy || '\u2014'), null, false],
      ['Modifier ID', `<span class="jcc-mono jcc-sm">${esc(j.metadata?.lastModifiedById || '\u2014')}</span>`, null, false],
      ['Last Modified At', fmtDate(j.metadata?.lastModifiedAt), null, false],
      ['Days Stale', `<span class="jcc-stale-badge ${stCls}">${days} days</span>`, null, false],
    ];
    let grid = '<div class="jcc-dgrid">';
    rows.forEach(([lbl, val, copyv, full]) => {
      const fc = full ? ' jcc-df' : '';
      const cb = copyv ? `<button class="jcc-copy" data-v="${esc(copyv)}">&#x1F4CB;</button>` : '';
      grid += `<div class="jcc-di${fc}"><span class="jcc-dlbl">${lbl}</span><span class="jcc-dval">${val}</span>${cb}</div>`;
    });
    grid += '</div>';
    dtr.innerHTML = `<td colspan="10"><div class="jcc-dpanel">${grid}</div></td>`;
    dtr.querySelectorAll('.jcc-copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        navigator.clipboard?.writeText(btn.dataset.v).then(() => {
          const orig = btn.textContent;
          btn.textContent = '\u2713';
          setTimeout(() => { btn.textContent = orig; }, 1500);
        });
      });
    });
    return dtr;
  }

  function render() {
    const tot = filtered.length;
    const pages = Math.max(1, Math.ceil(tot / ROWS_PER_PAGE));
    if (pg >= pages) pg = pages - 1;
    const items = filtered.slice(pg * ROWS_PER_PAGE, (pg + 1) * ROWS_PER_PAGE);

    rcEl.textContent = loading
      ? `Loaded ${all.length} (fetching\u2026) \u2014 ${tot} stale`
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
        const displayStatus = j.status || '—';
        const displaySc = sc;
        const journeyUrl = `https://experience.adobe.com/#/@${encodeURIComponent(cfg.tenantId)}/sname:${encodeURIComponent(cfg.sandbox)}/journey-optimizer/journeys/journey/${encodeURIComponent(j.id)}`;
        tr.innerHTML = [
          `<td><button class="jcc-tog" aria-expanded="${isExp}">${isExp ? '\u25B2' : '\u25BC'}</button></td>`,
          `<td class="jcc-cn" title="${esc(j.name || '')}"><span>${esc(j.name || '\u2014')}</span></td>`,
          `<td><span class="jcc-st jcc-st-${displaySc}">${esc(displayStatus)}</span></td>`,
          `<td class="jcc-cp" title="${esc(j.metadata?.createdById || '')}">${esc(j.metadata?.createdBy || '\u2014')}</td>`,
          `<td class="jcc-cd" title="${esc(j.metadata?.createdAt || '')}">${fmtDate(j.metadata?.createdAt)}</td>`,
          `<td class="jcc-cs ${stCls}">${days}d</td>`,
          `<td class="jcc-cgo"><a class="jcc-go-btn" href="${esc(journeyUrl)}" target="_blank" rel="noopener noreferrer" title="Open journey in AJO">&#x1F517; Go</a></td>`,
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

  // ── CSV export — downloads ALL stale journeys (not just current page/filter) ──
  function buildCsv(data) {
    const csvQ = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const displaySt = (s) => (s || '');
    const headers = ['ID', 'Name', 'Status', 'Version', 'Sandbox', 'IMS Org ID',
      'Created By', 'Created By ID', 'Created At',
      'Last Modified By', 'Last Modified By ID', 'Last Modified At',
      'Days Stale'];
    const rows = data.map((j) => [
      j.id, j.name, displaySt(j.status), j.version, j.sandboxName, j.imsOrgId,
      j.metadata?.createdBy, j.metadata?.createdById, j.metadata?.createdAt,
      j.metadata?.lastModifiedBy, j.metadata?.lastModifiedById, j.metadata?.lastModifiedAt,
      daysAgo(j.metadata?.lastModifiedAt),
    ].map(csvQ).join(','));
    return [headers.map(csvQ).join(','), ...rows].join('\r\n');
  }

  function triggerDownload(csvStr, filename) {
    const blob = new Blob([csvStr], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Download filtered results (current view)
  function exportCsv() {
    triggerDownload(buildCsv(filtered), `journey-cleanup-filtered-${todayIso()}.csv`);
    // eslint-disable-next-line no-console
    console.log(`[JCC] CSV exported (filtered) — ${filtered.length} rows`);
  }

  // Download ALL stale journeys regardless of current filters (excludes Live/deployed)
  function exportAllCsv() {
    const co = cutoff();
    const allStale = all.filter((j) => new Date(j.metadata?.lastModifiedAt) < co
      && (j.status || '').toLowerCase() !== 'deployed');
    triggerDownload(buildCsv(allStale), `journey-cleanup-all-${todayIso()}.csv`);
    // eslint-disable-next-line no-console
    console.log(`[JCC] CSV exported (all stale) — ${allStale.length} rows`);
  }

  function renderPag(tot, pages) {
    pagEl.innerHTML = '';
    if (pages <= 1) return;
    const mkBtn = (lbl, tgt, dis, act) => {
      const b = document.createElement('button');
      b.className = `jcc-pb${act ? ' jcc-pb-a' : ''}`;
      b.textContent = lbl;
      b.disabled = dis;
      if (!dis) {
        b.addEventListener('click', () => {
          pg = tgt;
          render();
          dash.querySelector('.jcc-tbl-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
      return b;
    };
    const mkDot = () => { const s = document.createElement('span'); s.className = 'jcc-pe'; s.textContent = '\u2026'; return s; };
    const info = document.createElement('span');
    info.className = 'jcc-pi';
    info.textContent = `Page ${pg + 1} / ${pages}  (${tot})`;
    pagEl.appendChild(info);
    const nav = document.createElement('div');
    nav.className = 'jcc-pnav';
    nav.appendChild(mkBtn('\u00AB', 0, pg === 0, false));
    nav.appendChild(mkBtn('\u2039', pg - 1, pg === 0, false));
    const R = 2;
    const rs = Math.max(0, pg - R);
    const re = Math.min(pages - 1, pg + R);
    if (rs > 0) { nav.appendChild(mkBtn('1', 0, false, false)); if (rs > 1) nav.appendChild(mkDot()); }
    for (let i = rs; i <= re; i += 1) nav.appendChild(mkBtn(String(i + 1), i, false, i === pg));
    if (re < pages - 1) { if (re < pages - 2) nav.appendChild(mkDot()); nav.appendChild(mkBtn(String(pages), pages - 1, false, false)); }
    nav.appendChild(mkBtn('\u203A', pg + 1, pg >= pages - 1, false));
    nav.appendChild(mkBtn('\u00BB', pages - 1, pg >= pages - 1, false));
    pagEl.appendChild(nav);
  }

  function setP(pct, lbl) { pf.style.width = `${Math.min(100, pct)}%`; pl.textContent = lbl; }
  function doneP() { pw.classList.add('jcc-pd'); setTimeout(() => { pw.style.display = 'none'; }, 600); }
  function showErr(msg) { errEl.style.display = 'block'; errEl.innerHTML = `\u26A0 ${esc(msg)}`; }

  function showStopBtn(visible) {
    stopBtn.style.display = visible ? 'inline-flex' : 'none';
  }

  // controls
  let st2;
  sqEl.addEventListener('input', () => {
    clearTimeout(st2);
    st2 = setTimeout(() => { nameQ = sqEl.value; sqClr.style.display = nameQ ? 'flex' : 'none'; applyF(); }, 250);
  });
  sqClr.style.display = 'none';
  sqClr.addEventListener('click', () => { sqEl.value = ''; nameQ = ''; sqClr.style.display = 'none'; applyF(); });
  sfEl.addEventListener('change', () => { statusQ = sfEl.value; applyF(); });
  cbEl.addEventListener('change', () => { createdByQ = cbEl.value; applyF(); });
  skEl.addEventListener('change', () => { sortK = skEl.value; applyF(); });

  // Bucket buttons
  dash.querySelectorAll('.jcc-bucket-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      bucketQ = btn.dataset.bucket;
      dash.querySelectorAll('.jcc-bucket-btn').forEach((b) => b.classList.remove('jcc-bucket-active'));
      btn.classList.add('jcc-bucket-active');
      applyF();
    });
  });

  sdBtn.addEventListener('click', () => {
    sortD = sortD === 'asc' ? 'desc' : 'asc';
    sdBtn.textContent = sortD === 'asc' ? '\u2191 Oldest' : '\u2193 Newest';
    applyF();
  });

  const csvBtn = dash.querySelector('#jr-csv');
  csvBtn.addEventListener('click', exportCsv);
  const csvAllBtn = dash.querySelector('#jr-csv-all');
  csvAllBtn.addEventListener('click', exportAllCsv);

  reconfigBtn.addEventListener('click', () => {
    showModal((newCfg) => { showDashboard(root, newCfg); });
  });

  refBtn.addEventListener('click', () => {
    all = []; filtered = []; loading = true;
    errEl.style.display = 'none';
    pw.style.display = ''; pw.classList.remove('jcc-pd'); pf.style.width = '0%';
    refBtn.disabled = true;
    updSummary(); applyF(); startLoad();
  });

  let fetchController = null;

  stopBtn.addEventListener('click', () => {
    if (fetchController) {
      fetchController.abort();
      fetchController = null;
      showStopBtn(false);
      loading = false;
      refBtn.disabled = false;
      setP(pf.style.width ? parseFloat(pf.style.width) : 0, `\u23F9 Stopped \u2014 ${all.length} journeys loaded`);
      pw.classList.remove('jcc-pd');
      updSummary(); updCreatedByFilter(); applyF();
      setTimeout(() => { pw.style.display = 'none'; }, 2000);
      // eslint-disable-next-line no-console
      console.log(`[JCC] Fetch stopped by user — ${all.length} journeys loaded so far`);
    }
  });

  function startLoad() {
    let totalPages = 0;
    showStopBtn(true);
    setP(5, 'Fetching page 1\u2026');
    fetchController = fetchAll(
      cfg,
      (chunk, cumul, pageNum) => {
        if (pageNum === 0 && chunk.length > 0) totalPages = totalPages || 1;
        totalPages = Math.max(totalPages, pageNum + 1);
        all = cumul;
        const pct = totalPages > 1 ? Math.min(90, Math.round((pageNum / totalPages) * 85) + 5) : 50;
        setP(pct, `Page ${pageNum + 1} loaded \u2014 ${cumul.length} journeys fetched\u2026`);
        updSummary();
        updCreatedByFilter();
        applyF();
      },
      (err) => { showErr(`Fetch error: ${err.message}`); },
      (final) => {
        fetchController = null;
        all = final; loading = false; refBtn.disabled = false;
        showStopBtn(false);
        setP(100, `Done \u2014 ${final.length} journeys loaded`);
        updSummary(); updCreatedByFilter(); applyF(); doneP();
      },
    );
  }

  startLoad();
}

// ─── pre-dashboard placeholder (no credentials yet) ──────────────────────────

function showPreDash(root) {
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'jcc-pre-dash';
  wrap.innerHTML = ''
    + '<span class="jcc-pre-icon">&#x1F9F9;</span>'
    + '<p style="font-size:1.1rem;font-weight:600;color:#2c2c2c;margin:0">Journey Cleanup Dashboard</p>'
    + '<p style="color:#6e6e6e;margin:0.25rem 0 1rem;font-size:0.9rem">No credentials configured. Open the config window to get started.</p>'
    + '<button class="jcc-btn-primary jcc-pre-open-cfg">&#x2699;&#xFE0F; Configure Credentials</button>';
  root.appendChild(wrap);
  wrap.querySelector('.jcc-pre-open-cfg').addEventListener('click', () => {
    showModal((newCfg) => showDashboard(root, newCfg));
  });
}

// ─── app entry ────────────────────────────────────────────────────────────────

function initApp(root) {
  const blockCfg = readCfg(root);
  const hasCfg = blockCfg.token && blockCfg.apiKey && blockCfg.orgId && blockCfg.sandbox;
  const saved = getSaved();
  const hasSaved = saved.token && saved.apiKey && saved.orgId && saved.sandbox;
  const cfg = hasCfg ? blockCfg : (hasSaved ? saved : null);

  if (cfg) {
    showDashboard(root, cfg);
  } else {
    showPreDash(root);
    showModal((newCfg) => showDashboard(root, newCfg));
  }
}

export default function decorate(block) {
  block.innerHTML = '';
  initApp(block);
}
