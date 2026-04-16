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

// Build an ISO date string like "2026-02-26" from a Date object
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function apiGet(cfg, page, afterDate) {
  // Exact filter format matching the working curl:
  //   status=draft,live&metadata.lastModifiedAt>2026-02-26
  // encodeURIComponent encodes = → %3D, , → %2C, & → %26, > → %3E
  const rawFilter = `status=draft,live&metadata.lastModifiedAt>${afterDate}`;
  const url = `${AJO_BASE}?pageSize=${PAGE_SIZE}&page=${page}&filter=${encodeURIComponent(rawFilter)}`;
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
    throw new Error(`HTTP ${res.status} – ${res.statusText}${body ? `: ${body}` : ''}`);
  }
  return res.json();
}

// Strategy: fetch pages 0,1,2… for a given afterDate window.
// Roll the window back 30 days at a time until no results or 2-year limit.
// Abort entirely on any HTTP error (no retry, no next window).
async function fetchAll(cfg, onChunk, onErr, onDone) {
  const all = [];
  const seen = new Set();
  let chunkIdx = 0;
  let fatalError = false;

  // Rolling 30-day windows back from today up to 2 years
  const today = new Date();
  const earliest = new Date(today);
  earliest.setFullYear(earliest.getFullYear() - 2);

  let windowEnd = new Date(today);
  let windowStart = new Date(today);
  windowStart.setDate(windowStart.getDate() - 30);

  while (!fatalError && windowStart >= earliest) {
    const afterDate = isoDate(windowStart);
    let page = 0;
    let pageGo = true;

    while (pageGo && !fatalError) {
      let data;
      try {
        data = await apiGet(cfg, page, afterDate);
      } catch (e) {
        // Stop all further API calls on any error (incl. 500)
        fatalError = true;
        onErr(e);
        break;
      }

      const raw = data.results || data.items || data.content || [];
      const items = raw.filter((j) => {
        if (seen.has(j.id)) return false;
        const t = new Date(j.metadata?.lastModifiedAt || 0).getTime();
        return t > windowStart.getTime() && t <= windowEnd.getTime();
      });

      if (items.length) {
        items.forEach((j) => seen.add(j.id));
        all.push(...items);
        onChunk([...items], [...all], chunkIdx);
        chunkIdx += 1;
      }

      // Stop paging if we got fewer than a full page
      if (raw.length < PAGE_SIZE) { pageGo = false; } else { page += 1; }
    }

    // Slide window back 30 days
    windowEnd = new Date(windowStart);
    windowStart = new Date(windowStart);
    windowStart.setDate(windowStart.getDate() - 30);
  }

  onDone([...all]);
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
    + `      <input id="jcc-m-apikey" name="apiKey" type="text" value="${esc(saved.apiKey || '')}" placeholder="e.g. e5b407a4..." />`
    + '    </div>'
    + '    <div class="jcc-field">'
    + '      <label class="jcc-label" for="jcc-m-sandbox">Sandbox Name <span class="jcc-req">*</span></label>'
    + `      <input id="jcc-m-sandbox" name="sandbox" type="text" value="${esc(saved.sandbox || '')}" placeholder="e.g. xlg-dev" />`
    + '    </div>'
    + '  </div>'
    + '  <div class="jcc-field">'
    + '    <label class="jcc-label" for="jcc-m-org">IMS Org ID <span class="jcc-req">*</span></label>'
    + `    <input id="jcc-m-org" name="orgId" type="text" value="${esc(saved.orgId || '')}" placeholder="e.g. 9E1005A5...@AdobeOrg" />`
    + '  </div>'
    + '  <div class="jcc-modal-error" id="jcc-modal-err" style="display:none"></div>'
    + '  <div class="jcc-modal-footer">'
    + '    <p class="jcc-modal-note">&#x1F512; Stored in sessionStorage only &mdash; never persisted or sent anywhere except Adobe APIs.</p>'
    + '    <button type="submit" class="jcc-btn-primary jcc-modal-submit">&#x1F680; Load Journeys</button>'
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
    };
    const errEl = box.querySelector('#jcc-modal-err');
    const missing = ['token', 'apiKey', 'orgId', 'sandbox'].filter((k) => !cfg[k]);
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

function showDashboard(root, cfg) {
  let all = [];
  let filtered = [];
  let pg = 0;
  let nameQ = '';
  let statusQ = 'all';
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
    + '    <button class="jcc-btn-sec" id="jr-reconfig">&#x2699; Reconfigure</button>'
    + '    <button class="jcc-btn-pri" id="jr-refresh" disabled>&#x21BA; Refresh</button>'
    + '  </div>'
    + '</div>'
    + '<div class="jcc-summary">'
    + '  <div class="jcc-sc jcc-sc-total"><span class="jcc-sn" id="st">&#x2014;</span><span class="jcc-sl">Total Stale</span></div>'
    + '  <div class="jcc-sc jcc-sc-live"><span class="jcc-sn" id="sl">&#x2014;</span><span class="jcc-sl">Live</span></div>'
    + '  <div class="jcc-sc jcc-sc-draft"><span class="jcc-sn" id="sd">&#x2014;</span><span class="jcc-sl">Draft</span></div>'
    + '  <div class="jcc-sc jcc-sc-failed"><span class="jcc-sn" id="sf">&#x2014;</span><span class="jcc-sl">Failed</span></div>'
    + '  <div class="jcc-sc jcc-sc-closed"><span class="jcc-sn" id="sc">&#x2014;</span><span class="jcc-sl">Closed/Stopped</span></div>'
    + '</div>'
    + '<div class="jcc-prog-wrap" id="jcc-pw">'
    + '  <div class="jcc-prog-track"><div class="jcc-prog-fill" id="jcc-pf"></div></div>'
    + '  <span class="jcc-prog-lbl" id="jcc-pl">Starting...</span>'
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
    + '        <option value="live">Live</option>'
    + '        <option value="draft">Draft</option>'
    + '        <option value="failed">Failed</option>'
    + '        <option value="closed">Closed</option>'
    + '        <option value="stopped">Stopped</option>'
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
    + '      <th></th><th>Name</th><th>Status</th><th>Ver.</th>'
    + '      <th>Sandbox</th><th>Created By</th><th>Created At</th>'
    + '      <th>Modified By</th><th>Last Modified</th><th>Stale</th>'
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
  const tb = dash.querySelector('#jcc-tb');
  const emEl = dash.querySelector('#jcc-empty');
  const sqEl = dash.querySelector('#jcc-sq');
  const sqClr = dash.querySelector('#jcc-sq-clr');
  const sfEl = dash.querySelector('#jcc-sf');
  const skEl = dash.querySelector('#jcc-sk');
  const sdBtn = dash.querySelector('#jcc-sd');
  const rcEl = dash.querySelector('#jcc-rc');
  const pagEl = dash.querySelector('#jcc-pag');
  const errEl = dash.querySelector('#jcc-eb');
  const reconfigBtn = dash.querySelector('#jr-reconfig');
  const refBtn = dash.querySelector('#jr-refresh');

  function updSummary() {
    const co = cutoff();
    const stale = all.filter((j) => new Date(j.metadata?.lastModifiedAt) < co);
    const cnt = (s) => stale.filter((j) => (j.status || '').toLowerCase() === s).length;
    dash.querySelector('#st').textContent = stale.length;
    dash.querySelector('#sl').textContent = cnt('live');
    dash.querySelector('#sd').textContent = cnt('draft');
    dash.querySelector('#sf').textContent = cnt('failed');
    dash.querySelector('#sc').textContent = cnt('closed') + cnt('stopped');
  }

  function applyF() {
    const co = cutoff();
    const q = nameQ.toLowerCase();
    filtered = all.filter((j) => {
      if (!(new Date(j.metadata?.lastModifiedAt) < co)) return false;
      if (statusQ !== 'all' && (j.status || '').toLowerCase() !== statusQ) return false;
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
        tr.innerHTML = [
          `<td><button class="jcc-tog" aria-expanded="${isExp}">${isExp ? '\u25B2' : '\u25BC'}</button></td>`,
          `<td class="jcc-cn" title="${esc(j.name || '')}"><span>${esc(j.name || '\u2014')}</span></td>`,
          `<td><span class="jcc-st jcc-st-${sc}">${esc(j.status || '\u2014')}</span></td>`,
          `<td class="jcc-cc">${esc(j.version || '\u2014')}</td>`,
          `<td>${esc(j.sandboxName || '\u2014')}</td>`,
          `<td class="jcc-cp" title="${esc(j.metadata?.createdById || '')}">${esc(j.metadata?.createdBy || '\u2014')}</td>`,
          `<td class="jcc-cd" title="${esc(j.metadata?.createdAt || '')}">${fmtDate(j.metadata?.createdAt)}</td>`,
          `<td class="jcc-cp" title="${esc(j.metadata?.lastModifiedById || '')}">${esc(j.metadata?.lastModifiedBy || '\u2014')}</td>`,
          `<td class="jcc-cd" title="${esc(j.metadata?.lastModifiedAt || '')}">${fmtDate(j.metadata?.lastModifiedAt)}</td>`,
          `<td class="jcc-cs ${stCls}">${days}d</td>`,
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

  // controls
  let st2;
  sqEl.addEventListener('input', () => {
    clearTimeout(st2);
    st2 = setTimeout(() => { nameQ = sqEl.value; sqClr.style.display = nameQ ? 'flex' : 'none'; applyF(); }, 250);
  });
  sqClr.style.display = 'none';
  sqClr.addEventListener('click', () => { sqEl.value = ''; nameQ = ''; sqClr.style.display = 'none'; applyF(); });
  sfEl.addEventListener('change', () => { statusQ = sfEl.value; applyF(); });
  skEl.addEventListener('change', () => { sortK = skEl.value; applyF(); });
  sdBtn.addEventListener('click', () => {
    sortD = sortD === 'asc' ? 'desc' : 'asc';
    sdBtn.textContent = sortD === 'asc' ? '\u2191 Oldest' : '\u2193 Newest';
    applyF();
  });

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

  function startLoad() {
    let pgCount = 0;
    setP(5, 'Fetching page 1...');
    fetchAll(
      cfg,
      (chunk, cumul, pageNum) => {
        pgCount = pageNum + 1;
        all = cumul;
        setP(Math.min(90, 5 + pgCount * 15), `Page ${pgCount} loaded \u2014 ${cumul.length} journeys fetched`);
        updSummary();
        applyF();
      },
      (err) => { showErr(`Fetch error: ${err.message}`); },
      (final) => {
        all = final; loading = false; refBtn.disabled = false;
        setP(100, `Done \u2014 ${final.length} total journeys fetched`);
        updSummary(); applyF(); doneP();
      },
    );
  }

  startLoad();
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
    // render empty dashboard shell behind modal so it is visible when modal closes
    root.innerHTML = '<div class="jcc-pre-dash"><span class="jcc-pre-icon">&#x1F9F9;</span><p>Loading credentials&hellip;</p></div>';
    showModal((newCfg) => showDashboard(root, newCfg));
  }
}

export default function decorate(block) {
  block.innerHTML = '';
  initApp(block);
}
