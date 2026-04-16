/* Journey Cleanup Dashboard - AJO stale journeys (30+ days) */
/* eslint-disable no-await-in-loop */

const AJO_BASE = 'https://platform.adobe.io/ajo/journey';
const PAGE_SIZE = 50;
const ROWS_PER_PAGE = 20;
const STALE_DAYS = 30;

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
  return { live: 'live', draft: 'draft', failed: 'failed', closed: 'closed', stopped: 'stopped' }[(status || '').toLowerCase()] || 'unknown';
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function staleClass(days) {
  if (days > 90) return 'jcc-stale-critical';
  if (days > 60) return 'jcc-stale-warn';
  return 'jcc-stale-ok';
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function apiGet(cfg, page) {
  const f = encodeURIComponent('status=draft,live,failed,closed,stopped');
  const url = `${AJO_BASE}?pageSize=${PAGE_SIZE}&page=${page}&filter=${f}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'x-api-key': cfg.apiKey,
      'x-gw-ims-org-id': cfg.orgId,
      'x-sandbox-name': cfg.sandbox,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} - ${res.statusText}`);
  return res.json();
}

async function fetchAll(cfg, onChunk, onErr, onDone) {
  const all = [];
  let pg = 0;
  let go = true;
  while (go) {
    let data;
    try {
      data = await apiGet(cfg, pg);
    } catch (e) {
      onErr(e);
      break;
    }
    const items = data.results || data.items || data.content || [];
    if (!items.length) break;
    all.push(...items);
    onChunk([...items], [...all], pg);
    if (items.length < PAGE_SIZE) { go = false; } else { pg += 1; }
  }
  onDone([...all]);
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

// ─── credential form ──────────────────────────────────────────────────────────

function showCredForm(root, onOk) {
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'jcc-cred-wrapper';

  const form = document.createElement('form');
  form.className = 'jcc-cred-form';
  form.innerHTML = '<div class="jcc-cred-logo"><span>&#x1F9F9;</span></div>'
    + '<h3 class="jcc-cred-title">Journey Cleanup Dashboard</h3>'
    + `<p class="jcc-cred-hint">Discover AJO journeys stale for ${STALE_DAYS}+ days.</p>`
    + '<div class="jcc-field"><label for="jcc-t">Access Token</label>'
    + '<textarea id="jcc-t" name="token" rows="3" placeholder="Bearer token..."></textarea></div>'
    + '<div class="jcc-field"><label for="jcc-k">API Key</label>'
    + '<input id="jcc-k" name="apiKey" type="text" placeholder="e5b407a4..." /></div>'
    + '<div class="jcc-field"><label for="jcc-o">IMS Org ID</label>'
    + '<input id="jcc-o" name="orgId" type="text" placeholder="9E1005A5...@AdobeOrg" /></div>'
    + '<div class="jcc-field"><label for="jcc-s">Sandbox Name</label>'
    + '<input id="jcc-s" name="sandbox" type="text" placeholder="xlg-dev" /></div>'
    + '<div class="jcc-cred-actions">'
    + '<button type="submit" class="jcc-btn-primary">&#x1F680; Load Journeys</button></div>'
    + '<p class="jcc-cred-note">Stored in sessionStorage only.</p>';

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const cfg = {
      token: (fd.get('token') || '').trim(),
      apiKey: (fd.get('apiKey') || '').trim(),
      orgId: (fd.get('orgId') || '').trim(),
      sandbox: (fd.get('sandbox') || '').trim(),
    };
    form.querySelector('.jcc-cred-error')?.remove();
    if (!cfg.token || !cfg.apiKey || !cfg.orgId || !cfg.sandbox) {
      const p = document.createElement('p');
      p.className = 'jcc-cred-error';
      p.textContent = '\u26A0 All fields are required.';
      form.querySelector('.jcc-cred-actions').before(p);
      return;
    }
    sessionStorage.setItem('jcc_cfg', JSON.stringify(cfg));
    onOk(cfg);
  });

  wrap.appendChild(form);
  root.appendChild(wrap);

  try {
    const saved = JSON.parse(sessionStorage.getItem('jcc_cfg') || '{}');
    if (saved.token) form.querySelector('#jcc-t').value = saved.token;
    if (saved.apiKey) form.querySelector('#jcc-k').value = saved.apiKey;
    if (saved.orgId) form.querySelector('#jcc-o').value = saved.orgId;
    if (saved.sandbox) form.querySelector('#jcc-s').value = saved.sandbox;
  } catch (_) { /* ignore */ }
}

// ─── dashboard ────────────────────────────────────────────────────────────────

function showDashboard(root, cfg) {
  // state
  let all = [];
  let filtered = [];
  let pg = 0;
  let nameQ = '';
  let statusQ = 'all';
  let sortK = 'lastModifiedAt';
  let sortD = 'asc';
  let loading = true;
  let expanded = null;

  // scaffold
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
    + '      <th></th>'
    + '      <th>Name</th>'
    + '      <th>Status</th>'
    + '      <th>Ver.</th>'
    + '      <th>Sandbox</th>'
    + '      <th>Created By</th>'
    + '      <th>Created At</th>'
    + '      <th>Modified By</th>'
    + '      <th>Last Modified</th>'
    + '      <th>Stale</th>'
    + '    </tr></thead>'
    + '    <tbody id="jcc-tb"></tbody>'
    + '  </table>'
    + '  <div id="jcc-empty" class="jcc-empty" style="display:none">'
    + '    <p>&#x1F50D; No stale journeys match the current filters.</p>'
    + '  </div>'
    + '</div>'

    + '<div id="jcc-pag" class="jcc-pag"></div>';

  root.appendChild(dash);

  // refs
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
  const refreshBtn = dash.querySelector('#jcc-refresh');
  const reconfigBtn = dash.querySelector('#jr-reconfig');
  const refBtn = dash.querySelector('#jr-refresh');

  // summary
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

  // filter + sort
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
        return sortD === 'asc'
          ? (a.name || '').localeCompare(b.name || '')
          : (b.name || '').localeCompare(a.name || '');
      }
      if (sortK === 'status') {
        return sortD === 'asc'
          ? (a.status || '').localeCompare(b.status || '')
          : (b.status || '').localeCompare(a.status || '');
      }
      const getTs = (j) => {
        const iso = sortK === 'createdAt' ? j.metadata?.createdAt : j.metadata?.lastModifiedAt;
        return new Date(iso || 0).getTime();
      };
      return sortD === 'asc' ? getTs(a) - getTs(b) : getTs(b) - getTs(a);
    });

    pg = 0;
    render();
  }

  // detail panel
  function mkDetail(j) {
    const sc = sClass(j.status);
    const days = daysAgo(j.metadata?.lastModifiedAt);
    const sc2 = staleClass(days);
    const dtr = document.createElement('tr');
    dtr.className = 'jcc-dtr';
    const rows = [
      ['Journey ID', `<span class="jcc-mono">${esc(j.id || '\u2014')}</span>`, j.id],
      ['IMS Org ID', `<span class="jcc-mono">${esc(j.imsOrgId || '\u2014')}</span>`, null],
      ['Name', esc(j.name || '\u2014'), null],
      ['Status', `<span class="jcc-st jcc-st-${sc}">${esc(j.status || '\u2014')}</span>`, null],
      ['Version', esc(j.version || '\u2014'), null],
      ['Sandbox', esc(j.sandboxName || '\u2014'), null],
      ['Created By', esc(j.metadata?.createdBy || '\u2014'), null],
      ['Creator ID', `<span class="jcc-mono jcc-sm">${esc(j.metadata?.createdById || '\u2014')}</span>`, null],
      ['Created At', fmtDate(j.metadata?.createdAt), null],
      ['Last Modified By', esc(j.metadata?.lastModifiedBy || '\u2014'), null],
      ['Modifier ID', `<span class="jcc-mono jcc-sm">${esc(j.metadata?.lastModifiedById || '\u2014')}</span>`, null],
      ['Last Modified At', fmtDate(j.metadata?.lastModifiedAt), null],
      ['Days Stale', `<span class="jcc-stale-badge ${sc2}">${days} days</span>`, null],
    ];
    let grid = '<div class="jcc-dgrid">';
    rows.forEach(([lbl, val, copyv]) => {
      const copyBtn = copyv ? `<button class="jcc-copy" data-v="${esc(copyv)}">&#x1F4CB;</button>` : '';
      const fullCls = lbl === 'Journey ID' || lbl === 'IMS Org ID' ? ' jcc-df' : '';
      grid += `<div class="jcc-di${fullCls}"><span class="jcc-dlbl">${lbl}</span><span class="jcc-dval">${val}</span>${copyBtn}</div>`;
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

  // render table
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
        const sc2 = staleClass(days);
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
          `<td class="jcc-cs ${sc2}">${days}d</td>`,
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

  // pagination
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

    const mkDot = () => {
      const s = document.createElement('span');
      s.className = 'jcc-pe';
      s.textContent = '\u2026';
      return s;
    };

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

  // progress
  function setP(pct, lbl) {
    pf.style.width = `${Math.min(100, pct)}%`;
    pl.textContent = lbl;
  }

  function doneP() {
    pw.classList.add('jcc-pd');
    setTimeout(() => { pw.style.display = 'none'; }, 600);
  }

  function showErr(msg) {
    errEl.style.display = 'block';
    errEl.innerHTML = `\u26A0 ${esc(msg)}`;
  }

  // event wiring
  let st2;
  sqEl.addEventListener('input', () => {
    clearTimeout(st2);
    st2 = setTimeout(() => {
      nameQ = sqEl.value;
      sqClr.style.display = nameQ ? 'flex' : 'none';
      applyF();
    }, 250);
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

  reconfigBtn.addEventListener('click', () => { initApp(root); });

  refBtn.addEventListener('click', () => {
    all = [];
    filtered = [];
    loading = true;
    errEl.style.display = 'none';
    pw.style.display = '';
    pw.classList.remove('jcc-pd');
    pf.style.width = '0%';
    refBtn.disabled = true;
    updSummary();
    applyF();
    startLoad();
  });

  // start fetch
  function startLoad() {
    let pgCount = 0;
    setP(5, 'Fetching page 1...');
    fetchAll(
      cfg,
      (chunk, cumul, pageNum) => {
        pgCount = pageNum + 1;
        all = cumul;
        const pct = Math.min(90, 5 + pgCount * 15);
        setP(pct, `Page ${pgCount} loaded — ${cumul.length} journeys fetched`);
        updSummary();
        applyF();
      },
      (err) => {
        showErr(`Fetch error: ${err.message}`);
      },
      (final) => {
        all = final;
        loading = false;
        refBtn.disabled = false;
        setP(100, `Done — ${final.length} total journeys fetched`);
        updSummary();
        applyF();
        doneP();
      },
    );
  }

  startLoad();
}

// ─── app entry ────────────────────────────────────────────────────────────────

function initApp(root) {
  const blockCfg = readCfg(root);
  const hasCfg = blockCfg.token && blockCfg.apiKey && blockCfg.orgId && blockCfg.sandbox;
  const sessionCfg = (() => {
    try { return JSON.parse(sessionStorage.getItem('jcc_cfg') || '{}'); } catch (_) { return {}; }
  })();
  const cfg = hasCfg ? blockCfg : (sessionCfg.token ? sessionCfg : null);

  if (cfg && cfg.token && cfg.apiKey && cfg.orgId && cfg.sandbox) {
    showDashboard(root, cfg);
  } else {
    showCredForm(root, (newCfg) => showDashboard(root, newCfg));
  }
}

export default function decorate(block) {
  block.innerHTML = '';
  initApp(block);
}
