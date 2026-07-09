/* Journey Cleanup Dashboard - AJO stale journeys (30+ days) + AI Risk Scoring */
/* eslint-disable no-await-in-loop */
import {
  computeRuleScore, isDefaultJourneyName,
  scoreBadgeHtml, aiDetailHtml, journeyTypeBadgeHtml,
  checkProxyHealth, createAgentPool, fetchTokenStats,
  fetchJourneyDetail, scoreSingleLLM,
} from './jcc-ai-core.js';
import {
  saveSnapshot, loadSnapshot, clearSnapshot, listSnapshots, getCacheCapacity,
  hydrateScores, fmtSnapshotDate,
} from './jcc-cache.js';

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
  return ({ live: 'live', deployed: 'live', draft: 'draft', failed: 'failed', closed: 'closed', finished: 'closed', stopped: 'stopped' })[(status || '').toLowerCase()] || 'unknown';
}

function statusLabel(status) {
  return ({ live: 'Deployed', deployed: 'Deployed', closed: 'Finished', finished: 'Finished', stopped: 'Stopped', draft: 'Draft', failed: 'Failed' })[(status || '').toLowerCase()] || (status || '\u2014');
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
  const f = `status=draft,failed,stopped,closed,finished,live,deployed&metadata.lastModifiedAt<${todayIso()}`;
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
    if (items0.length) { all.push(...items0); onChunk([...items0], [...all], 0, total); }
    if (pages <= 1) { onDone([...all]); return; }
    for (let p = 1; p < pages; p += 1) {
      if (signal.aborted) break;
      let d;
      try { d = await apiGet(cfg, p, signal); } catch (e) { if (e.name === 'AbortError') break; onErr(e); break; }
      const items = d.results || [];
      if (!items.length) break;
      all.push(...items);
      onChunk([...items], [...all], p, total);
    }
    onDone([...all]);
  })();
  return ctrl;
}

// ─── tip popover ──────────────────────────────────────────────────────────────

function closeTipPopover() { document.querySelector('.jcc-tip-popover')?.remove(); }

function showTipPopover(iconEl, tipText) {
  // Close any existing popover first
  closeTipPopover();

  const pop = document.createElement('div');
  pop.className = 'jcc-tip-popover';
  pop.setAttribute('role', 'tooltip');
  pop.innerHTML = `
    <div class="jcc-tip-popover-hdr">
      <span class="jcc-tip-popover-title">&#x2139; Use Case Info</span>
      <button class="jcc-tip-popover-close" aria-label="Close">&#x2715;</button>
    </div>
    <div class="jcc-tip-popover-body">${tipText}</div>
  `;
  document.body.appendChild(pop);

  // Position: prefer above the icon, fall back to below if not enough space
  const rect = iconEl.getBoundingClientRect();
  const popW = 280;
  const popH = pop.offsetHeight || 100;
  const margin = 8;

  let top = rect.top - popH - margin;
  if (top < 8) top = rect.bottom + margin; // flip to below
  let left = rect.left + rect.width / 2 - popW / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - popW - 8));

  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;

  // Close on button click
  pop.querySelector('.jcc-tip-popover-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTipPopover();
  });

  // Close when clicking outside
  function onOutsideClick(e) {
    if (!pop.contains(e.target) && e.target !== iconEl) {
      closeTipPopover();
      document.removeEventListener('click', onOutsideClick, true);
    }
  }
  // Defer so the current click doesn't immediately close it
  setTimeout(() => document.addEventListener('click', onOutsideClick, true), 0);
}

// ─── modal ────────────────────────────────────────────────────────────────────

function closeModal() { document.querySelector('.jcc-modal-overlay')?.remove(); document.body.classList.remove('jcc-no-scroll'); }

// Verify credentials by making a lightweight AJO API call (fetch page 0, size 1)
async function verifyCredentials(c) {
  const f = `status=draft,failed,stopped,closed,finished,live,deployed&metadata.lastModifiedAt<${todayIso()}`;
  const url = `${AJO_BASE}?pageSize=1&page=0&filter=${encodeURIComponent(f)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${c.token}`, 'x-api-key': c.apiKey, 'x-gw-ims-org-id': c.orgId, 'x-sandbox-name': c.sandbox },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint = res.status === 401 ? 'Invalid token or API key'
      : res.status === 403 ? 'Insufficient permissions'
        : res.status === 404 ? 'Sandbox not found'
          : `HTTP ${res.status}`;
    throw new Error(`${hint}${body ? ': ' + body.slice(0, 120) : ''}`);
  }
  const data = await res.json();
  return data.pagination?.totalCount ?? (data.results || []).length;
}

// ─── mode selection ───────────────────────────────────────────────────────────

function showModeSelect(root, cfg) {
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'jcc-mode-select';
  wrap.innerHTML = `
    <div class="jcc-ms-header">
      <span class="jcc-ms-icon">&#x1F9F9;</span>
      <div>
        <h2 class="jcc-ms-title">Journey Cleanup Dashboard</h2>
        <p class="jcc-ms-sub">Connected to sandbox: <strong>${esc(cfg.sandbox)}</strong></p>
      </div>
    </div>
    <p class="jcc-ms-prompt">How would you like to analyze your journeys?</p>

    <div class="jcc-ms-section">
      <div class="jcc-ms-section-header">
        <span class="jcc-ms-section-icon">&#x1F5FA;</span>
        <span class="jcc-ms-section-title">Journey</span>
      </div>
      <div class="jcc-ms-cards">
        <button class="jcc-ms-card" id="jcc-ms-all">
          <span class="jcc-ms-card-icon">&#x1F4CA;</span>
          <span class="jcc-ms-card-title">Analyze All</span>
          <span class="jcc-ms-card-desc">Fetch &amp; score all stale journeys not modified in 30+ days. Supports AI risk scoring, filtering, CSV export and more.</span>
        </button>
        <button class="jcc-ms-card" id="jcc-ms-single">
          <span class="jcc-ms-card-icon">&#x1F50D;</span>
          <span class="jcc-ms-card-title">Analyze by Journey ID</span>
          <span class="jcc-ms-card-desc">Look up a specific journey by its UUID. Instantly get rule-based and AI risk analysis for that single journey.</span>
        </button>
      </div>
    </div>

    <div class="jcc-ms-section">
      <div class="jcc-ms-section-header">
        <span class="jcc-ms-section-icon">&#x1F4E3;</span>
        <span class="jcc-ms-section-title">Campaign</span>
      </div>
      <div class="jcc-ms-cards">
        <button class="jcc-ms-card jcc-ms-card-soon" id="jcc-ms-camp-all" disabled>
          <span class="jcc-ms-card-icon">&#x1F4CA;</span>
          <span class="jcc-ms-card-title">Analyze All</span>
          <span class="jcc-ms-card-desc">Fetch &amp; score all stale campaigns. Supports AI risk scoring, filtering, CSV export and more.</span>
          <span class="jcc-ms-coming-soon">Coming Soon</span>
        </button>
        <button class="jcc-ms-card jcc-ms-card-soon" id="jcc-ms-camp-single" disabled>
          <span class="jcc-ms-card-icon">&#x1F50D;</span>
          <span class="jcc-ms-card-title">Analyze by Campaign ID</span>
          <span class="jcc-ms-card-desc">Look up a specific campaign by its UUID. Instantly get rule-based and AI risk analysis for that single campaign.</span>
          <span class="jcc-ms-coming-soon">Coming Soon</span>
        </button>
      </div>
    </div>

    <div class="jcc-ms-section">
      <div class="jcc-ms-section-header">
        <span class="jcc-ms-section-icon">&#x1F4CA;</span>
        <span class="jcc-ms-section-title">AJO Delivery Report</span>
      </div>
      <div class="jcc-ms-cards">
        <button class="jcc-ms-card jcc-ms-card-soon" id="jcc-ms-del-summary" disabled>
          <span class="jcc-ms-card-icon">&#x1F4CB;</span>
          <span class="jcc-ms-card-title">Delivery Summary</span>
          <span class="jcc-ms-card-desc">View aggregated delivery metrics across journeys &mdash; sent, delivered, opened, bounced and more.</span>
          <span class="jcc-ms-coming-soon">Coming Soon</span>
        </button>
        <button class="jcc-ms-card jcc-ms-card-soon" id="jcc-ms-del-channel" disabled>
          <span class="jcc-ms-card-icon">&#x1F4E1;</span>
          <span class="jcc-ms-card-title">Channel Breakdown</span>
          <span class="jcc-ms-card-desc">Analyse performance by channel &mdash; Email, SMS, Push, In-App &mdash; with click-through and engagement rates.</span>
          <span class="jcc-ms-coming-soon">Coming Soon</span>
        </button>
      </div>
    </div>

    <p class="jcc-ms-note">&#x1F512; Credentials stored in sessionStorage only.</p>
  `;
  root.appendChild(wrap);
  wrap.querySelector('#jcc-ms-all').addEventListener('click', () => showDashboard(root, cfg));
  wrap.querySelector('#jcc-ms-single').addEventListener('click', () => showJourneyIdLookup(root, cfg));
}

// ─── journey id lookup ────────────────────────────────────────────────────────

function showJourneyIdLookup(root, cfg) {
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'jcc-id-lookup';

  const aiSaved = getAiSettings();
  let aiEnabled = !!aiSaved.enabled;
  let proxyUrl = aiSaved.proxyUrl || 'http://localhost:3001';

  wrap.innerHTML = `
    <div class="jcc-idl-header">
      <button class="jcc-idl-back jcc-btn-sec" id="jcc-idl-back">&#x2190; Back</button>
      <span class="jcc-idl-header-icon">&#x1F50D;</span>
      <div>
        <h2 class="jcc-idl-title">Analyze by Journey ID</h2>
        <p class="jcc-idl-sub">Sandbox: <strong>${esc(cfg.sandbox)}</strong></p>
      </div>
    </div>
    <div class="jcc-idl-form-wrap">
      <div class="jcc-idl-form-row">
        <input id="jcc-idl-input" class="jcc-idl-input" type="text"
          placeholder="Paste Journey UUID e.g. 3fa85f64-5717-4562-b3fc-2c963f66afa6"
          autocomplete="off" spellcheck="false" />
        <button class="jcc-btn-primary jcc-idl-analyze-btn" id="jcc-idl-submit">&#x1F50D; Analyze</button>
      </div>
      <div class="jcc-idl-ai-row">
        <label class="jcc-ai-toggle-lbl">
          <input type="checkbox" id="jcc-idl-ai-chk"${aiEnabled ? ' checked' : ''} />
          <span>&#x1F916; Smart AI Analyze</span>
        </label>
        <div class="jcc-ai-cfg" id="jcc-idl-ai-cfg">
          <label class="jcc-ai-cfg-lbl" for="jcc-idl-ai-url">Proxy:</label>
          <input id="jcc-idl-ai-url" class="jcc-ai-url" type="text" value="${esc(proxyUrl)}" placeholder="http://localhost:3001" />
          <button id="jcc-idl-health-chk" class="jcc-btn-health">&#x1F50D; Test</button>
          <span id="jcc-idl-ai-status" class="jcc-ai-status jcc-ai-s-unknown">&#x25CF; Not checked</span>
        </div>
      </div>
      <div id="jcc-idl-err" class="jcc-idl-err" style="display:none"></div>
    </div>
    <div id="jcc-idl-result" class="jcc-idl-result" style="display:none"></div>
  `;
  root.appendChild(wrap);

  const inputEl = wrap.querySelector('#jcc-idl-input');
  const submitBtn = wrap.querySelector('#jcc-idl-submit');
  const errEl = wrap.querySelector('#jcc-idl-err');
  const resultEl = wrap.querySelector('#jcc-idl-result');
  const aiChk = wrap.querySelector('#jcc-idl-ai-chk');
  const aiUrlEl = wrap.querySelector('#jcc-idl-ai-url');
  const aiStatusEl = wrap.querySelector('#jcc-idl-ai-status');
  const aiHealthBtn = wrap.querySelector('#jcc-idl-health-chk');

  function updAiStatus(ok, msg) {
    aiStatusEl.className = `jcc-ai-status ${ok ? 'jcc-ai-s-ok' : 'jcc-ai-s-err'}`;
    aiStatusEl.textContent = `\u25CF ${msg}`;
  }

  async function testProxyHealth() {
    aiStatusEl.className = 'jcc-ai-status jcc-ai-s-unknown';
    aiStatusEl.textContent = '\u25CF Checking\u2026';
    const health = await checkProxyHealth(proxyUrl);
    if (health.ok) updAiStatus(true, `Connected \u2014 ${health.model || 'unknown model'}`);
    else updAiStatus(false, `Offline: ${health.error || 'unreachable'}`);
    return health;
  }

  aiChk.addEventListener('change', () => {
    aiEnabled = aiChk.checked;
    saveAiSettings({ enabled: aiEnabled, proxyUrl });
    if (aiEnabled) testProxyHealth();
  });

  aiUrlEl.addEventListener('change', () => {
    proxyUrl = aiUrlEl.value.trim() || 'http://localhost:3001';
    saveAiSettings({ enabled: aiEnabled, proxyUrl });
  });

  aiHealthBtn.addEventListener('click', () => {
    proxyUrl = aiUrlEl.value.trim() || 'http://localhost:3001';
    testProxyHealth();
  });

  if (aiEnabled) testProxyHealth();

  // Allow Enter key to submit
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitBtn.click(); });

  wrap.querySelector('#jcc-idl-back').addEventListener('click', () => showModeSelect(root, cfg));

  submitBtn.addEventListener('click', async () => {
    const rawId = inputEl.value.trim();
    errEl.style.display = 'none';
    resultEl.style.display = 'none';

    if (!rawId) {
      errEl.style.display = 'flex';
      errEl.textContent = '\u26A0 Please enter a Journey ID.';
      return;
    }

    // Basic UUID format check
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(rawId)) {
      errEl.style.display = 'flex';
      errEl.textContent = '\u26A0 That doesn\u2019t look like a valid Journey UUID. Expected format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
      return;
    }

    // Show loading state
    submitBtn.disabled = true;
    submitBtn.textContent = '\u23F3 Fetching\u2026';
    resultEl.style.display = 'block';
    resultEl.innerHTML = '<div class="jcc-idl-loading">\u23F3 Fetching journey from AJO API\u2026</div>';

    let journey;
    try {
      journey = await fetchJourneyDetail(cfg, rawId);
    } catch (e) {
      submitBtn.disabled = false;
      submitBtn.textContent = '\uD83D\uDD0D Analyze';
      resultEl.style.display = 'none';
      errEl.style.display = 'flex';
      const isAuthErr = e.message.includes('401') || e.message.includes('403');
      const hint = e.message.includes('404') ? `Journey not found in sandbox \u201C${cfg.sandbox}\u201D \u2014 verify the ID and sandbox.`
        : isAuthErr ? 'Authentication failed \u2014 your token may have expired.'
          : `API error: ${e.message}`;
      if (isAuthErr) {
        errEl.style.display = 'flex';
        errEl.innerHTML = `<span class="jcc-idl-err-msg">\u274C ${esc(hint)}</span>`
          + `<button class="jcc-btn-update-token" id="jcc-idl-update-token">\uD83D\uDD11 Update Access Token</button>`;
        errEl.querySelector('#jcc-idl-update-token').addEventListener('click', () => {
          showModal((nc) => {
            // Update the local cfg reference and re-render lookup page with new credentials
            Object.assign(cfg, nc);
            showJourneyIdLookup(root, nc);
          });
        });
      } else {
        errEl.style.display = 'flex';
        errEl.textContent = `\u274C ${hint}`;
      }
      return;
    }

    // Rule score (instant)
    const rule = computeRuleScore(journey);
    renderSingleResult(resultEl, cfg, journey, rule, null, false);
    submitBtn.disabled = false;
    submitBtn.textContent = '\uD83D\uDD0D Analyze';

    // LLM score (if enabled)
    if (aiEnabled) {
      const health = await testProxyHealth();
      if (!health.ok) {
        // Update result card to show proxy-offline note
        renderSingleResult(resultEl, cfg, journey, rule, { error: 'AI proxy is offline \u2014 rule-based score only.' }, false);
        return;
      }
      renderSingleResult(resultEl, cfg, journey, rule, null, true); // show "analyzing…"
      try {
        const llm = await scoreSingleLLM(journey, proxyUrl);
        renderSingleResult(resultEl, cfg, journey, rule, llm, false);
      } catch (e) {
        renderSingleResult(resultEl, cfg, journey, rule, { error: e.message }, false);
      }
    }
  });
}

function renderSingleResult(container, cfg, j, rule, llm, analyzing) {
  const sc = sClass(j.status);
  const days = daysAgo(j.metadata?.lastModifiedAt);
  const stCls = sc2(days);
  const journeyUrl = `https://experience.adobe.com/#/@${encodeURIComponent(cfg.tenantId)}/sname:${encodeURIComponent(cfg.sandbox)}/journey-optimizer/journeys/journey/${encodeURIComponent(j.id)}`;

  const fields = [
    ['Journey ID', `<span class="jcc-mono">${esc(j.id || '\u2014')}</span>`],
    ['IMS Org ID', `<span class="jcc-mono">${esc(j.imsOrgId || '\u2014')}</span>`],
    ['Name', esc(j.name || '\u2014')],
    ['Status', `<span class="jcc-st jcc-st-${sc}">${esc(statusLabel(j.status))}</span>`],
    ['Version', esc(j.version || '\u2014')],
    ['Sandbox', esc(j.sandboxName || '\u2014')],
    ['Created By', esc(j.metadata?.createdBy || '\u2014')],
    ['Created At', fmtDate(j.metadata?.createdAt)],
    ['Last Modified By', esc(j.metadata?.lastModifiedBy || '\u2014')],
    ['Last Modified At', fmtDate(j.metadata?.lastModifiedAt)],
    ['Days Stale', `<span class="jcc-stale-badge ${stCls}">${days} days</span>`],
  ];

  let gridHtml = '<div class="jcc-dgrid">';
  fields.forEach(([lbl, val], i) => {
    const full = i < 2 ? ' jcc-df' : ''; // Journey ID and Org ID span full width
    gridHtml += `<div class="jcc-di${full}"><span class="jcc-dlbl">${lbl}</span><span class="jcc-dval">${val}</span></div>`;
  });
  gridHtml += '</div>';

  let aiHtml = '';
  if (analyzing) {
    aiHtml = '<div class="jcc-ai-detail"><div class="jcc-ai-detail-hdr"><span>&#x1F916;</span> AI Risk Analysis</div><div class="jcc-ai-analyzing" style="padding:0.75rem 1rem">\u23F3 Running LLM analysis\u2026</div></div>';
  } else {
    aiHtml = aiDetailHtml(rule, llm);
  }

  container.innerHTML = `
    <div class="jcc-idl-result-card">
      <div class="jcc-idl-result-hdr">
        <div class="jcc-idl-result-title">
          <span class="jcc-st jcc-st-${sc}">${esc(statusLabel(j.status))}</span>
          <span class="jcc-idl-result-name">${esc(j.name || '\u2014')}</span>
        </div>
        <a class="jcc-go-btn" href="${esc(journeyUrl)}" target="_blank" rel="noopener noreferrer">&#x1F517; Open in AJO</a>
      </div>
      <div class="jcc-dpanel">
        ${gridHtml}
        ${aiHtml}
      </div>
    </div>
  `;
}

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
    '<div class="jcc-modal-connect-status" id="jcc-modal-cs" style="display:none"></div>',
    '<div class="jcc-modal-footer"><p class="jcc-modal-note">&#x1F512; sessionStorage only.</p>',
    '<div class="jcc-modal-actions"><button type="button" class="jcc-btn-secondary jcc-modal-cancel">&#x2715; Cancel</button>',
    '<button type="submit" class="jcc-btn-primary" id="jcc-modal-connect">&#x1F517; Connect</button></div></div>',
    '</form>',
  ].join('');
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  document.body.classList.add('jcc-no-scroll');
  setTimeout(() => { box.querySelector('textarea')?.focus(); }, 80);

  const formEl = box.querySelector('#jcc-modal-form');
  const errEl = box.querySelector('#jcc-modal-err');
  const csEl = box.querySelector('#jcc-modal-cs');
  const connectBtn = box.querySelector('#jcc-modal-connect');

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const c = { token: (fd.get('token') || '').trim(), apiKey: (fd.get('apiKey') || '').trim(), orgId: (fd.get('orgId') || '').trim(), sandbox: (fd.get('sandbox') || '').trim(), tenantId: (fd.get('tenantId') || '').trim() };
    const missing = ['token', 'apiKey', 'orgId', 'sandbox', 'tenantId'].filter((k) => !c[k]);
    if (missing.length) {
      errEl.style.display = 'flex'; csEl.style.display = 'none';
      errEl.textContent = `\u26A0 Fill in: ${missing.join(', ')}`;
      return;
    }
    errEl.style.display = 'none';
    // Show connecting state
    connectBtn.disabled = true;
    connectBtn.textContent = '\u23F3 Connecting\u2026';
    csEl.style.display = 'flex';
    csEl.className = 'jcc-modal-connect-status jcc-cs-pending';
    csEl.textContent = '\u23F3 Verifying credentials against AJO API\u2026';

    try {
      const count = await verifyCredentials(c);
      csEl.className = 'jcc-modal-connect-status jcc-cs-ok';
      csEl.textContent = `\u2705 Connected \u2014 sandbox: ${c.sandbox} (${count.toLocaleString()} journeys found)`;
      connectBtn.textContent = '\u2714 Connected!';
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(c));
      // Brief pause so user sees success, then show mode selection
      setTimeout(() => { closeModal(); onOk(c); }, 900);
    } catch (err) {
      csEl.className = 'jcc-modal-connect-status jcc-cs-err';
      csEl.textContent = `\u274C Connection failed: ${err.message}`;
      connectBtn.disabled = false;
      connectBtn.textContent = '\u1F517 Connect';
    }
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
function buildCsv(data, cfg, aiScores) {
  const hdrs = [
    'ID', 'Name', 'Status', 'Version', 'Sandbox',
    'Created By', 'Created At', 'Last Modified By', 'Last Modified At', 'Days Stale',
    'Rule Score', 'AI Score (Blended)', 'AI Verdict',
    'Journey Type', 'Use Case Summary', 'Target Audience',
    'Business Value', 'Business Purpose',
    'AI Reasoning', 'Recommendation', 'AI Confidence',
    'AJO URL',
  ];
  const rows = data.map((j) => {
    const entry = aiScores ? aiScores.get(j.id) : null;
    const rule = entry?.rule || null;
    const llm = entry?.llm && !entry.llm.error ? entry.llm : null;
    const ruleScore = rule ? rule.score : '';
    const blended = (rule && llm) ? Math.round(rule.score * 0.4 + (llm.retirementScore || 0) * 0.6)
      : (rule ? rule.score : '');
    return [
      j.id, j.name, statusLabel(j.status), j.version, j.sandboxName,
      j.metadata?.createdBy, j.metadata?.createdAt,
      j.metadata?.lastModifiedBy, j.metadata?.lastModifiedAt,
      daysAgo(j.metadata?.lastModifiedAt),
      ruleScore,
      blended,
      llm ? llm.retirementLabel : (rule ? (rule.score >= 80 ? 'Safe to Delete' : rule.score >= 50 ? 'Review First' : 'Keep Active') : ''),
      llm ? llm.journeyType : '',
      llm ? llm.useCaseSummary : '',
      llm ? llm.targetAudience : '',
      llm ? llm.businessValue : '',
      llm ? llm.businessPurpose : '',
      llm ? llm.reasoning : '',
      llm ? llm.recommendation : '',
      llm ? llm.confidence : '',
      `https://experience.adobe.com/#/@${encodeURIComponent(cfg.tenantId)}/sname:${encodeURIComponent(cfg.sandbox)}/journey-optimizer/journeys/journey/${j.id}`,
    ].map(csvQ).join(',');
  });
  return [hdrs.map(csvQ).join(','), ...rows].join('\r\n');
}

function triggerDownload(csv, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ─── cache banner (shown when snapshots exist) ────────────────────────────────
// Shows all cached sandboxes as switchable cards (max 5). The active sandbox
// (cfg.sandbox) is highlighted. Clicking another sandbox card switches to it.

function showCacheBanner(root, snap, cfg) {
  return new Promise((resolve) => {
    root.innerHTML = '';

    // Load full list of sandboxes from IndexedDB, then build the UI
    listSnapshots().then((allSnaps) => {
      const el = document.createElement('div');
      el.className = 'jcc-cache-banner';

      // ── Sandbox switcher tabs ─────────────────────────────────────────────
      const capacity = allSnaps.length;
      const maxSandboxes = 5;
      let tabsHtml = `
        <div class="jcc-cb-switcher-hdr">
          <span class="jcc-cb-sw-title">\uD83D\uDCE6 Cached Sandboxes</span>
          <span class="jcc-cb-sw-cap">${capacity} / ${maxSandboxes}</span>
        </div>
        <div class="jcc-cb-tabs">
      `;
      allSnaps.forEach((s) => {
        const isActive = s.sandbox === cfg.sandbox;
        const staleIcon = s.isStale ? '\u26A0\uFE0F' : '\u2705';
        tabsHtml += `
          <button class="jcc-cb-tab${isActive ? ' jcc-cb-tab-active' : ''}" data-sandbox="${esc(s.sandbox)}">
            <span class="jcc-cb-tab-name">${esc(s.sandbox)}</span>
            <span class="jcc-cb-tab-meta">${staleIcon} ${s.journeyCount} journeys &middot; ${s.daysOld}d old</span>
          </button>
        `;
      });
      tabsHtml += '</div>';

      // ── Active sandbox detail panel ───────────────────────────────────────
      const staleBadge = snap.isStale
        ? `<span class="jcc-cb-stale-badge">\u26A0 ${snap.daysOld} days old \u2014 consider refreshing</span>`
        : `<span class="jcc-cb-fresh-badge">\u2705 ${snap.daysOld} days old</span>`;

      const detailHtml = `
        <div class="jcc-cb-detail">
          <div class="jcc-cb-info${snap.isStale ? ' jcc-cb-stale' : ''}">
            <div class="jcc-cb-title">Snapshot \u2014 <strong>${esc(cfg.sandbox)}</strong></div>
            <div class="jcc-cb-meta">
              Analyzed: <strong>${fmtSnapshotDate(snap.analyzedAt)}</strong>
              &nbsp;\u00B7&nbsp; ${snap.journeyCount} journeys
              &nbsp;\u00B7&nbsp; ${snap.aiScoredCount} AI-scored
              &nbsp;&nbsp;${staleBadge}
            </div>
          </div>
          <div class="jcc-cb-actions">
            <button class="jcc-btn-primary jcc-cb-load">\u26A1 Load from cache</button>
            <button class="jcc-btn-secondary jcc-cb-fresh">\uD83D\uDD04 Run fresh analysis</button>
            <button class="jcc-btn-sec jcc-cb-clear">\uD83D\uDDD1 Clear cache</button>
          </div>
        </div>
      `;

      const backBtnHtml = `<button class="jcc-btn-sec jcc-cb-back" id="jcc-cb-back-btn">&#x2190; Back</button>`;
      el.innerHTML = backBtnHtml + tabsHtml + detailHtml;
      root.appendChild(el);

      // ── Back button → mode select ─────────────────────────────────────────
      el.querySelector('#jcc-cb-back-btn').addEventListener('click', () => resolve({ action: 'back', cfg }));

      // ── Tab click → switch sandbox ────────────────────────────────────────
      el.querySelectorAll('.jcc-cb-tab').forEach((tab) => {
        tab.addEventListener('click', async () => {
          const targetSandbox = tab.dataset.sandbox;
          if (targetSandbox === cfg.sandbox) return; // already active

          // Update cfg to target sandbox (inherit credentials — same org/token)
          const newCfg = { ...cfg, sandbox: targetSandbox };

          // Load snapshot for the switched-to sandbox
          let targetSnap = null;
          try { targetSnap = await loadSnapshot(targetSandbox); } catch (_) { /* ignore */ }

          if (targetSnap) {
            // Re-render the cache banner for the new sandbox, then resolve as 'switch'
            showCacheBanner(root, targetSnap, newCfg).then((choice) => {
              // Propagate the choice with the updated cfg
              if (choice === 'cache') resolve({ action: 'cache', cfg: newCfg, snap: targetSnap });
              else if (choice === 'fresh') resolve({ action: 'fresh', cfg: newCfg });
              else if (choice === 'clear') resolve({ action: 'clear', cfg: newCfg });
              else if (choice && typeof choice === 'object') resolve(choice);
            });
          } else {
            // No cache for that sandbox — go straight to fresh analysis
            resolve({ action: 'fresh', cfg: newCfg });
          }
        });
      });

      el.querySelector('.jcc-cb-load').addEventListener('click', () => resolve({ action: 'cache', cfg, snap }));
      el.querySelector('.jcc-cb-fresh').addEventListener('click', () => resolve({ action: 'fresh', cfg }));
      el.querySelector('.jcc-cb-clear').addEventListener('click', () => resolve({ action: 'clear', cfg }));
    }).catch(() => {
      // Fallback: IndexedDB unavailable — show simple banner
      const el = document.createElement('div');
      el.className = 'jcc-cache-banner';
      el.innerHTML = `<button class="jcc-btn-sec jcc-cb-back" id="jcc-cb-back-btn-fb">&#x2190; Back</button>`;
      const staleBadge = snap.isStale
        ? `<span class="jcc-cb-stale-badge">\u26A0 ${snap.daysOld} days old \u2014 consider refreshing</span>`
        : `<span class="jcc-cb-fresh-badge">\u2705 ${snap.daysOld} days old</span>`;
      el.innerHTML += `
        <div class="jcc-cb-icon">\uD83D\uDCE6</div>
        <div class="jcc-cb-info${snap.isStale ? ' jcc-cb-stale' : ''}">
          <div class="jcc-cb-title">Cached snapshot \u2014 <strong>${esc(cfg.sandbox)}</strong></div>
          <div class="jcc-cb-meta">
            Analyzed: <strong>${fmtSnapshotDate(snap.analyzedAt)}</strong>
            &nbsp;\u00B7&nbsp; ${snap.journeyCount} journeys
            &nbsp;\u00B7&nbsp; ${snap.aiScoredCount} AI-scored
            &nbsp;&nbsp;${staleBadge}
          </div>
        </div>
        <div class="jcc-cb-actions">
          <button class="jcc-btn-primary jcc-cb-load">\u26A1 Load from cache</button>
          <button class="jcc-btn-secondary jcc-cb-fresh">\uD83D\uDD04 Run fresh analysis</button>
          <button class="jcc-btn-sec jcc-cb-clear">\uD83D\uDDD1 Clear cache</button>
        </div>
      `;
      root.appendChild(el);
      el.querySelector('#jcc-cb-back-btn-fb').addEventListener('click', () => resolve({ action: 'back', cfg }));
      el.querySelector('.jcc-cb-load').addEventListener('click', () => resolve({ action: 'cache', cfg, snap }));
      el.querySelector('.jcc-cb-fresh').addEventListener('click', () => resolve({ action: 'fresh', cfg }));
      el.querySelector('.jcc-cb-clear').addEventListener('click', () => resolve({ action: 'clear', cfg }));
    });
  });
}

// ─── dashboard ────────────────────────────────────────────────────────────────

async function showDashboard(root, cfg) {
  // Check for cached snapshot before fetching from API
  let cachedSnap = null;
  try { cachedSnap = await loadSnapshot(cfg.sandbox); } catch (_) { /* ignore IDB errors */ }

  // Also check whether any OTHER sandboxes are cached — if so, always show the switcher
  let otherSnaps = [];
  try { otherSnaps = await listSnapshots(); } catch (_) { /* ignore */ }
  const hasAnyCached = cachedSnap || otherSnaps.length > 0;

  if (hasAnyCached) {
    // If current sandbox has no snapshot, create a synthetic placeholder so the banner
    // can still show the switcher tabs for other sandboxes
    const snapForBanner = cachedSnap || {
      sandbox: cfg.sandbox,
      analyzedAt: null,
      accessedAt: null,
      journeyCount: 0,
      aiScoredCount: 0,
      daysOld: 0,
      isStale: false,
      journeys: [],
      aiScores: {},
      _noCache: true,
    };

    const result = await showCacheBanner(root, snapForBanner, cfg);

    // Normalise: banner now always returns an object {action, cfg, snap?}
    const action = typeof result === 'object' ? result.action : result;
    const resolvedCfg = (typeof result === 'object' && result.cfg) ? result.cfg : cfg;
    const resolvedSnap = (typeof result === 'object' && result.snap) ? result.snap : cachedSnap;

    if (action === 'back') {
      showModeSelect(root, resolvedCfg);
      return;
    }

    if (action === 'cache' && resolvedSnap && !resolvedSnap._noCache) {
      const restoredScores = hydrateScores(resolvedSnap.aiScores);
      showDashboardCore(root, resolvedCfg, resolvedSnap.journeys, restoredScores, resolvedSnap);
      return;
    }
    if (action === 'clear') {
      try { await clearSnapshot(resolvedCfg.sandbox); } catch (_) { /* ignore */ }
    }
    // 'fresh' or no-cache: fall through to live fetch with the (possibly switched) cfg
    showDashboardCore(root, resolvedCfg, null, null, null);
    return;
  }

  showDashboardCore(root, cfg, null, null, null);
}

function showDashboardCore(root, cfg, initialJourneys, initialScores, snap) {
  let all = initialJourneys ? [...initialJourneys] : [];
  let filtered = []; let pg = 0;
  let nameQ = ''; let statusQ = 'all'; let createdByQ = 'all'; let bucketQ = 'all'; let aiCategoryQ = 'all';
  let sortK = 'lastModifiedAt'; let sortD = 'asc'; let loading = true; let expanded = null;

  const aiSaved = getAiSettings();
  let aiEnabled = !!aiSaved.enabled;
  let includeLive = false; // always defaults OFF — not persisted across sessions
  let proxyUrl = aiSaved.proxyUrl || 'http://localhost:3001';
  // Hydrate from cache if provided; otherwise start empty
  const aiScores = initialScores || new Map();
  const detailCache = new Map();
  let agentPool = null;
  let aiRunning = false;
  let snapshotSaved = !!snap; // don't auto-save again if loaded from cache

  root.innerHTML = '';
  const dash = document.createElement('div');
  dash.className = 'jcc-dashboard';

  // Cache info banner (shown when loaded from cache)
  let snapBannerHtml = '';
  if (snap) {
    const staleWarn = snap.isStale ? '<span class="jcc-snap-stale-txt"> \u26A0 Over 90 days old</span>' : '';
    snapBannerHtml = `<div class="jcc-snap-info${snap.isStale ? ' jcc-snap-stale' : ''}" id="jcc-snap-info">`
      + `\uD83D\uDCE6 Loaded from cache &nbsp;\u00B7&nbsp; Analyzed: <strong>${fmtSnapshotDate(snap.analyzedAt)}</strong>`
      + ` &nbsp;\u00B7&nbsp; ${snap.journeyCount} journeys &nbsp;\u00B7&nbsp; ${snap.aiScoredCount} AI-scored${staleWarn}`
      + ` <button class="jcc-btn-sec jcc-snap-refresh">\uD83D\uDD04 Run fresh</button>`
      + '</div>';
  }

  dash.innerHTML = [
    snapBannerHtml,
    // Header
    '<div class="jcc-header">',
    '  <div class="jcc-header-left">',
    '    <button class="jcc-btn-sec jcc-back-btn" id="jr-back">&#x2190; Home</button>',
    '    <span class="jcc-hi">&#x1F9F9;</span><div>',
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
    // ── Unified progress + AI bar ─────────────────────────────────────────
    '<div class="jcc-unified-bar" id="jcc-unified-bar">',
    // Phase 1: Fetch
    '  <div class="jcc-phase-row">',
    '    <span class="jcc-phase-lbl jcc-phase-fetch-lbl">&#x1F4E1; Fetch</span>',
    '    <div class="jcc-prog-track"><div class="jcc-prog-fill" id="jcc-pf"></div></div>',
    '    <span class="jcc-prog-lbl" id="jcc-pl">Starting\u2026</span>',
    '    <button class="jcc-stop-btn" id="jcc-stop" style="display:none">&#x23F9; Stop</button>',
    '  </div>',
    // Phase 2: Score (rule always; LLM if enabled)
    '  <div class="jcc-phase-row" id="jcc-phase-score">',
    '    <span class="jcc-phase-lbl jcc-phase-score-lbl">&#x1F9E0; Score</span>',
    '    <div class="jcc-prog-track"><div class="jcc-prog-fill jcc-prog-fill-score" id="jcc-ai-pf"></div></div>',
    '    <span class="jcc-prog-lbl" id="jcc-ai-pl">Waiting for fetch\u2026</span>',
    '  </div>',
    // AI settings row
    '  <div class="jcc-ai-settings-row">',
    '    <label class="jcc-ai-toggle-lbl">',
    `      <input type="checkbox" id="jcc-ai-chk"${aiEnabled ? ' checked' : ''} />`,
    '      <span>&#x1F916; Smart AI Analyze</span>',
    '    </label>',
    '    <span class="jcc-ai-tip">When ON: LLM scores <strong>draft</strong> journeys after loading. OFF = instant rule scoring only.</span>',
    '    <label class="jcc-ai-toggle-lbl jcc-ai-live-lbl" title="Also run LLM on live (deployed) journeys — slower but catches risky live campaigns">',
    `      <input type="checkbox" id="jcc-ai-live-chk"${includeLive ? ' checked' : ''} />`,
    '      <span>📡 Include live journeys</span>',
    '    </label>',
    '    <div class="jcc-ai-cfg" id="jcc-ai-cfg">',
    '      <label class="jcc-ai-cfg-lbl" for="jcc-ai-url">Proxy:</label>',
    `      <input id="jcc-ai-url" class="jcc-ai-url" type="text" value="${esc(proxyUrl)}" placeholder="http://localhost:3001" />`,
    '      <button id="jcc-ai-health-chk" class="jcc-btn-health">&#x1F50D; Test</button>',
    '      <span id="jcc-ai-status" class="jcc-ai-status jcc-ai-s-unknown">&#x25CF; Not checked</span>',
    '    </div>',
    '    <div class="jcc-ai-actions">',
    '      <button id="jcc-ai-stop" class="jcc-btn-ai-stop" style="display:none">&#x23F9; Stop LLM</button>',
    '    </div>',
    '  </div>',
    // AI counts row
    '  <div class="jcc-ai-counts" id="jcc-ai-counts" style="display:none">',
    '    <span class="jcc-ai-counts-lbl">Filter:</span>',
    '    <button class="jcc-ai-cnt jcc-ai-cnt-retire" id="jcc-ai-retire" data-cat="retire" title="Show only Delete journeys">&#x1F534; 0 Delete</button>',
    '    <button class="jcc-ai-cnt jcc-ai-cnt-review" id="jcc-ai-review" data-cat="review" title="Show only Review journeys">&#x1F7E1; 0 Review</button>',
    '    <button class="jcc-ai-cnt jcc-ai-cnt-keep"   id="jcc-ai-keep"   data-cat="keep"   title="Show only Keep journeys">&#x1F7E2; 0 Keep</button>',
    '    <button class="jcc-ai-cnt jcc-ai-cnt-all" id="jcc-ai-all" data-cat="all" title="Show all journeys">&#x26AA; All</button>',
    '  </div>',
    '</div>',
    // Summary
    '<div class="jcc-summary">',
    '  <div class="jcc-sc jcc-sc-total">',
    '    <div class="jcc-sc-circle"><span class="jcc-sn" id="st">\u2014</span><span class="jcc-sl-inner">Total</span></div>',
    '    <span class="jcc-sl">Total</span>',
    '  </div>',
    '  <div class="jcc-sc jcc-sc-draft">',
    '    <div class="jcc-sc-circle"><span class="jcc-sn" id="sd">\u2014</span><span class="jcc-sl-inner">Draft</span></div>',
    '    <span class="jcc-sl">Draft</span>',
    '  </div>',
    '  <div class="jcc-sc jcc-sc-live">',
    '    <div class="jcc-sc-circle"><span class="jcc-sn" id="sl">\u2014</span><span class="jcc-sl-inner">Live</span></div>',
    '    <span class="jcc-sl">Live</span>',
    '  </div>',
    '  <div class="jcc-sc jcc-sc-closed">',
    '    <div class="jcc-sc-circle"><span class="jcc-sn" id="sc">\u2014</span><span class="jcc-sl-inner">Finished</span></div>',
    '    <span class="jcc-sl">Finished</span>',
    '  </div>',
    '  <div class="jcc-sc jcc-sc-stopped">',
    '    <div class="jcc-sc-circle"><span class="jcc-sn" id="sk">\u2014</span><span class="jcc-sl-inner">Stopped</span></div>',
    '    <span class="jcc-sl">Stopped</span>',
    '  </div>',
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
    // Controls
    '<div class="jcc-controls">',
    '  <div class="jcc-search-wrap"><span>&#x1F50D;</span>',
    '    <input id="jcc-sq" class="jcc-search" type="text" placeholder="Search name, ID, owner\u2026" autocomplete="off" />',
    '    <button id="jcc-sq-clr" class="jcc-clr-btn" style="display:none">&#x2715;</button>',
    '  </div>',
    '  <div class="jcc-filter-row">',
    '    <div class="jcc-fg"><label for="jcc-sf">Status</label>',
    '      <select id="jcc-sf" class="jcc-sel"><option value="all">All</option><option value="draft">Draft</option><option value="live">Live</option><option value="failed">Failed</option><option value="finished">Finished</option><option value="stopped">Stopped</option></select>',
    '    </div>',
    '    <div class="jcc-fg"><label for="jcc-cb">Owner</label>',
    '      <select id="jcc-cb" class="jcc-sel"><option value="all">All Owners</option></select>',
    '    </div>',
    '    <div class="jcc-fg" id="jcc-ai-cat-fg" style="display:none"><label for="jcc-ai-cat">AI Category</label>',
    '      <select id="jcc-ai-cat" class="jcc-sel">',
    '        <option value="all">All</option>',
    '        <option value="retire">\uD83D\uDD34 Delete</option>',
    '        <option value="review">\uD83D\uDFE1 Review</option>',
    '        <option value="keep">\uD83D\uDFE2 Keep</option>',
    '      </select>',
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
    '  <table class="jcc-tbl"><thead><tr id="jcc-thead-row">',
    '    <th></th><th>Name</th><th>Status</th><th>Owner</th><th>Created</th><th>Last Modified</th><th id="jcc-th-ai" style="display:none">AI Verdict</th><th>Go</th>',
    '  </tr></thead><tbody id="jcc-tb"></tbody></table>',
    '  <div id="jcc-empty" class="jcc-empty" style="display:none"><p>&#x1F50D; No stale journeys match.</p></div>',
    '</div>',
    '<div id="jcc-pag" class="jcc-pag"></div>',
  ].join('');

  root.appendChild(dash);

  // Element refs
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
  const aiUrlEl = dash.querySelector('#jcc-ai-url');
  const aiStatusEl = dash.querySelector('#jcc-ai-status');
  const aiLiveChk = dash.querySelector('#jcc-ai-live-chk');
  const aiHealthBtn = dash.querySelector('#jcc-ai-health-chk');
  const aiStopBtn = dash.querySelector('#jcc-ai-stop');
  const aiCountsEl = dash.querySelector('#jcc-ai-counts');
  const aiCatFg = dash.querySelector('#jcc-ai-cat-fg');
  const aiCatEl = dash.querySelector('#jcc-ai-cat');
  const aiPf = dash.querySelector('#jcc-ai-pf');
  const aiPl = dash.querySelector('#jcc-ai-pl');

  // ── info icon popover — event delegation on tbody ──────────────────────────
  tb.addEventListener('click', (e) => {
    const icon = e.target.closest('.jcc-info-icon');
    if (!icon) return;
    e.stopPropagation();
    const tip = icon.getAttribute('data-tip') || '';
    showTipPopover(icon, tip);
  });

  // ── summary ────────────────────────────────────────────────────────────────

  function updSummary() {
    const co = cutoff();
    const stale = all.filter((j) => new Date(j.metadata?.lastModifiedAt) < co);
    const cnt = (s) => stale.filter((j) => (j.status || '').toLowerCase() === s).length;
    dash.querySelector('#st').textContent = stale.length;
    dash.querySelector('#sd').textContent = cnt('draft');
    dash.querySelector('#sl').textContent = cnt('live') + cnt('deployed');
    dash.querySelector('#sc').textContent = cnt('closed') + cnt('finished');
    dash.querySelector('#sk').textContent = cnt('stopped');
    const bCnt = (b) => stale.filter((j) => getBucket(daysAgo(j.metadata?.lastModifiedAt)) === b).length;
    dash.querySelector('#bk-0-30').textContent = bCnt('0-30');
    dash.querySelector('#bk-31-60').textContent = bCnt('31-60');
    dash.querySelector('#bk-61-90').textContent = bCnt('61-90');
    dash.querySelector('#bk-90plus').textContent = bCnt('90+');
  }

  function updOwnerFilter() {
    const co = cutoff();
    const stale = all.filter((j) => new Date(j.metadata?.lastModifiedAt) < co);
    const names = [...new Set(stale.map((j) => j.metadata?.createdBy || '').filter(Boolean))].sort();
    const prev = cbEl.value;
    cbEl.innerHTML = '<option value="all">All Owners</option>' + names.map((n) => `<option value="${esc(n)}"${n === prev ? ' selected' : ''}>${esc(n)}</option>`).join('');
  }

  // ── AI category helper ─────────────────────────────────────────────────────

  function getAiCategory(id) {
    const e = aiScores.get(id);
    if (!e) return null;
    const { rule, llm } = e;
    const score = llm && !llm.error
      ? Math.round(rule.score * 0.4 + (llm.retirementScore || 0) * 0.6)
      : rule.score;
    if (score >= 80) return 'retire';
    if (score >= 50) return 'review';
    return 'keep';
  }

  function setAiCategoryFilter(val) {
    aiCategoryQ = val;
    if (aiCatEl) aiCatEl.value = val;
    // Update active state on count buttons
    aiCountsEl.querySelectorAll('[data-cat]').forEach((btn) => {
      btn.classList.toggle('jcc-ai-cnt-active', btn.dataset.cat === val);
    });
    applyF();
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
      if (statusQ !== 'all') {
        const apiStatus = (j.status || '').toLowerCase();
        // 'finished' filter value matches both 'closed' and 'finished' API statuses
        // 'live' filter value matches both 'live' and 'deployed' API statuses
        if (statusQ === 'finished') {
          if (apiStatus !== 'closed' && apiStatus !== 'finished') return false;
        } else if (statusQ === 'live') {
          if (apiStatus !== 'live' && apiStatus !== 'deployed') return false;
        } else if (apiStatus !== statusQ) {
          return false;
        }
      }
      if (createdByQ !== 'all' && (j.metadata?.createdBy || '') !== createdByQ) return false;
      if (bucketQ !== 'all' && getBucket(daysAgo(j.metadata?.lastModifiedAt)) !== bucketQ) return false;
      if (aiCategoryQ !== 'all') {
        const cat = getAiCategory(j.id);
        if (cat !== aiCategoryQ) return false;
      }
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
      ['Status', `<span class="jcc-st jcc-st-${sc}">${esc(statusLabel(j.status))}</span>`, null, false],
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
    // A journey is pending LLM if AI is running and it has only a rule score (no llm result yet)
    const aiPendingRow = aiRunning && aiEntry && !aiEntry.llm;
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

  // Whether any journey has a score (rule or LLM) — controls AI Verdict column visibility
  function hasAnyScores() { return aiScores.size > 0; }

  function render() {
    const tot = filtered.length;
    const pages = Math.max(1, Math.ceil(tot / ROWS_PER_PAGE));
    if (pg >= pages) pg = pages - 1;
    const items = filtered.slice(pg * ROWS_PER_PAGE, (pg + 1) * ROWS_PER_PAGE);

    // Show AI Verdict column and AI Category filter as soon as any scores exist
    const showAiCol = hasAnyScores();
    const aiTh = dash.querySelector('#jcc-th-ai');
    if (aiTh) aiTh.style.display = showAiCol ? '' : 'none';
    if (aiCatFg) aiCatFg.style.display = showAiCol ? 'flex' : 'none';
    const colSpan = showAiCol ? 8 : 7;

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
        const pending = aiRunning && aiEntry && !aiEntry.llm;
        // Verdict pill in table row (score details live in the expanded panel)
        let verdictCell = '';
        if (showAiCol) {
          if (pending) {
            verdictCell = '<span class="jcc-ai-analyzing" style="font-size:0.72rem">\u23F3</span>';
          } else if (aiEntry) {
            if (aiEntry.llm && !aiEntry.llm.error) {
              // LLM result available — show full AI verdict with color
              const cat = getAiCategory(j.id);
              const catMap = {
                retire: { cls: 'jcc-verdict-pill-retire', icon: '\uD83D\uDD34', lbl: 'Delete' },
                review: { cls: 'jcc-verdict-pill-review', icon: '\uD83D\uDFE1', lbl: 'Review' },
                keep:   { cls: 'jcc-verdict-pill-keep',   icon: '\uD83D\uDFE2', lbl: 'Keep'   },
              };
              const cv = cat ? catMap[cat] : catMap.keep;
              verdictCell = `<span class="jcc-verdict-pill ${cv.cls}">${cv.icon} ${cv.lbl}</span>`;
            } else {
              // Rule score only — show neutral "Tool Verdict" pill
              verdictCell = '<span class="jcc-verdict-pill jcc-verdict-pill-tool">\u2699\uFE0F Tool Verdict</span>';
            }
          } else {
            verdictCell = '<span class="jcc-verdict-pill-empty">\u2014</span>';
          }
        }
        tr.innerHTML = [
          `<td><button class="jcc-tog" aria-expanded="${isExp}">${isExp ? '\u25B2' : '\u25BC'}</button></td>`,
          `<td class="jcc-cn" title="${esc(j.name || '')}"><span>${esc(j.name || '\u2014')}</span></td>`,
          `<td><span class="jcc-st jcc-st-${sc}">${esc(statusLabel(j.status))}</span></td>`,
          `<td class="jcc-cp" title="${esc(j.metadata?.createdBy || '')}">${esc(j.metadata?.createdBy || '\u2014')}</td>`,
          `<td class="jcc-cd">${fmtDate(j.metadata?.createdAt)}</td>`,
          `<td class="jcc-cs ${stCls}">${days}d</td>`,
          showAiCol ? `<td class="jcc-cai">${verdictCell}</td>` : '',
          `<td class="jcc-cgo"><a class="jcc-go-btn" href="${esc(journeyUrl)}" target="_blank" rel="noopener noreferrer">&#x1F517; Go</a></td>`,
        ].join('');
        tb.appendChild(tr);
        tr.querySelector('.jcc-tog').addEventListener('click', () => {
          expanded = expanded === j.id ? null : j.id;
          render();
        });
        if (isExp) {
          const dtr = mkDetail(j);
          // Keep detail colspan in sync with visible columns
          dtr.querySelector('td')?.setAttribute('colspan', String(colSpan));
          tb.appendChild(dtr);
        }
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
  function showErr(msg) { errEl.style.display = 'block'; errEl.innerHTML = `\u26A0 ${esc(msg)}`; }

  // Rule-score all journeys in a chunk immediately (no network, instant)
  function applyRuleScores(journeys) {
    journeys.forEach((j) => {
      if (!aiScores.has(j.id)) {
        const rule = computeRuleScore(j);
        aiScores.set(j.id, { rule, llm: null });
      }
    });
  }

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
    } else {
      updAiStatus(false, `Offline: ${health.error || 'unreachable'}`);
    }
    return health;
  }

  // ── Timing helpers ─────────────────────────────────────────────────────────

  function fmtDur(ms) {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60); const rs = s % 60;
    return `${m}m ${rs < 10 ? '0' : ''}${rs}s`;
  }

  // ── Proxy-down error banner ────────────────────────────────────────────────

  let pendingAiTargets = []; // kept for Retry

  function showProxyDownBanner(errMsg) {
    // Remove any existing banner first
    dash.querySelector('.jcc-proxy-down-banner')?.remove();

    const banner = document.createElement('div');
    banner.className = 'jcc-proxy-down-banner';
    banner.innerHTML = [
      '<span class="jcc-pdb-icon">&#x26A0;</span>',
      '<div class="jcc-pdb-body">',
      '  <strong>AI proxy stopped responding</strong>',
      `  <span class="jcc-pdb-detail">${esc(errMsg || 'Connection refused or timed out')}</span>`,
      '  <span class="jcc-pdb-hint">Restart the proxy: <code>cd ai-proxy &amp;&amp; node server.js</code></span>',
      '</div>',
      '<div class="jcc-pdb-actions">',
      '  <button class="jcc-btn-primary jcc-pdb-retry">&#x21BA; Retry AI</button>',
      '  <button class="jcc-btn-secondary jcc-pdb-dismiss">&#x2715; Dismiss</button>',
      '</div>',
    ].join('');

    // Insert after the unified bar
    const unifiedBar = dash.querySelector('#jcc-unified-bar');
    unifiedBar?.insertAdjacentElement('afterend', banner);

    banner.querySelector('.jcc-pdb-retry').addEventListener('click', async () => {
      banner.remove();
      // Re-test proxy health before retrying
      const health = await checkProxyHealth(proxyUrl);
      if (!health.ok) {
        updAiStatus(false, `Still offline: ${health.error || 'unreachable'}`);
        showProxyDownBanner(`Still unreachable: ${health.error || 'unreachable'}`);
        return;
      }
      updAiStatus(true, `Reconnected \u2014 ${health.model || 'unknown model'}`);
      // Only retry journeys that don't yet have a successful LLM score
      const remaining = pendingAiTargets.filter((j) => {
        const e = aiScores.get(j.id);
        return !e?.llm || e.llm.error;
      });
      if (remaining.length) {
        aiPl.textContent = `\u21BA Retrying LLM on ${remaining.length} remaining journeys\u2026`;
        startAI(remaining);
      } else {
        aiPl.textContent = '\u2705 All journeys already scored.';
      }
    });

    banner.querySelector('.jcc-pdb-dismiss').addEventListener('click', () => banner.remove());
  }

  // LLM analysis — runs after fetch completes (if aiEnabled)
  function startAI(targets) {
    if (aiRunning || !targets.length) return;
    aiRunning = true;
    pendingAiTargets = targets; // save for retry
    const aiStartMs = Date.now();
    aiStopBtn.style.display = 'inline-flex';
    aiCountsEl.style.display = 'flex';
    aiPf.style.width = '0%';
    aiPl.textContent = `\uD83E\uDD16 Starting LLM analysis on ${targets.length} journeys\u2026`;

    agentPool = createAgentPool({
      cfg, proxyUrl, detailCache,
      onScore(id, rule, llm) {
        // Merge LLM result into existing rule score entry
        aiScores.set(id, { rule, llm });
        render();
      },
      onProgress({ done, total, retireCount, reviewCount, keepCount }) {
        const pct = Math.round((done / total) * 100);
        aiPf.style.width = `${pct}%`;

        // Timing
        const elapsed = Date.now() - aiStartMs;
        const avgMs = done > 0 ? Math.round(elapsed / done) : 0;
        const remaining = done > 0 ? Math.round(((total - done) * avgMs)) : 0;
        const timeParts = done > 0
          ? ` \u00B7 avg ${fmtDur(avgMs)}/journey \u00B7 ~${fmtDur(remaining)} left \u00B7 elapsed ${fmtDur(elapsed)}`
          : '';

        aiPl.textContent = `\uD83E\uDD16 LLM: ${done}/${total} journeys scored${timeParts}`;
        dash.querySelector('#jcc-ai-retire').textContent = `\uD83D\uDD34 ${retireCount} Delete`;
        dash.querySelector('#jcc-ai-review').textContent = `\uD83D\uDFE1 ${reviewCount} Review`;
        dash.querySelector('#jcc-ai-keep').textContent = `\uD83D\uDFE2 ${keepCount} Keep`;
      },
      onComplete() {
        aiRunning = false;
        aiStopBtn.style.display = 'none';
        const totalElapsed = Date.now() - aiStartMs;
        const avgMs = targets.length > 0 ? Math.round(totalElapsed / targets.length) : 0;
        aiPl.textContent = `\u2705 LLM done \u2014 ${targets.length} journeys in ${fmtDur(totalElapsed)} \u00B7 avg ${fmtDur(avgMs)}/journey`;
        aiPf.style.width = '100%';
        render();
        // Fetch and display token usage
        fetchTokenStats(proxyUrl).then((stats) => {
          if (!stats) return;
          const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
          const tokenInfo = `\uD83D\uDCCA Tokens: ${fmt(stats.totalPromptTokens)} in \u00B7 ${fmt(stats.totalCompletionTokens)} out \u00B7 ${fmt(stats.totalTokens)} total`;
          aiPl.textContent += ` \u00B7 ${tokenInfo}`;
          // Show token info in a dedicated element if present
          const tokenEl = dash.querySelector('#jcc-token-stats');
          if (tokenEl) {
            tokenEl.textContent = tokenInfo;
            tokenEl.style.display = 'inline';
          }
        }).catch(() => { /* ignore */ });
        // Auto-save full snapshot after LLM completes
        if (!snapshotSaved) {
          snapshotSaved = true;
          saveSnapshot(cfg.sandbox, all, aiScores)
            .then(() => { aiPl.textContent += ' \u2014 \uD83D\uDCBE Saved to cache'; })
            .catch(() => { /* ignore */ });
        }
      },
      onProxyDown(errMsg) {
        aiRunning = false;
        aiStopBtn.style.display = 'none';
        aiPl.textContent = `\u26A0 LLM proxy offline \u2014 ${aiScores.size} journeys scored before failure`;
        updAiStatus(false, 'Proxy offline');
        showProxyDownBanner(errMsg);
        render();
      },
    });
    agentPool.enqueue(targets);
  }

  // ── event wiring ───────────────────────────────────────────────────────────

  aiChk.addEventListener('change', () => {
    aiEnabled = aiChk.checked;
    saveAiSettings({ enabled: aiEnabled, proxyUrl });
    if (aiEnabled) testProxy();
    render();
  });

  aiLiveChk.addEventListener('change', () => {
    includeLive = aiLiveChk.checked;
    // not persisted — resets to false on next page load

    // If AI is already running or fetch is done, recompute targets and add live journeys
    if (includeLive && all.length > 0) {
      const co = cutoff();
      const liveTargets = all.filter((j) => {
        if (!(new Date(j.metadata?.lastModifiedAt) < co)) return false;
        const s = (j.status || '').toLowerCase();
        return (s === 'live' || s === 'deployed') && !(aiScores.get(j.id)?.llm);
      });
      if (liveTargets.length > 0) {
        // Apply rule scores first
        applyRuleScores(liveTargets);
        if (aiEnabled) {
          if (aiRunning && agentPool) {
            // Already running — enqueue live journeys into existing pool
            pendingAiTargets = [...pendingAiTargets, ...liveTargets];
            agentPool.enqueue(liveTargets);
            aiPl.textContent = `\uD83E\uDD16 LLM: added ${liveTargets.length} live journeys \u2014 now ${pendingAiTargets.length} total\u2026`;
          } else if (!aiRunning && !loading) {
            // Fetch is done, AI completed — collect ALL unscored journeys (draft + live)
            // so the progress counter reflects the true combined total
            const allUnscoredTargets = all.filter((j) => {
              if (!(new Date(j.metadata?.lastModifiedAt) < co)) return false;
              const s = (j.status || '').toLowerCase();
              const alreadyScored = !!(aiScores.get(j.id)?.llm && !aiScores.get(j.id)?.llm.error);
              if (alreadyScored) return false;
              return s === 'draft' || s === 'live' || s === 'deployed';
            });
            if (allUnscoredTargets.length > 0) {
              applyRuleScores(allUnscoredTargets);
              aiPl.textContent = `\uD83E\uDD16 Starting LLM on ${allUnscoredTargets.length} journeys (draft + live)\u2026`;
              startAI(allUnscoredTargets);
            }
          }
        }
        applyF();
      }
    }
  });

  aiUrlEl.addEventListener('change', () => {
    proxyUrl = aiUrlEl.value.trim() || 'http://localhost:3001';
    saveAiSettings({ enabled: aiEnabled, proxyUrl });
  });

  aiHealthBtn.addEventListener('click', () => { proxyUrl = aiUrlEl.value.trim() || 'http://localhost:3001'; testProxy(); });

  // ── AI category filter & count button events ───────────────────────────────
  if (aiCatEl) aiCatEl.addEventListener('change', () => setAiCategoryFilter(aiCatEl.value));
  aiCountsEl.querySelectorAll('[data-cat]').forEach((btn) => {
    btn.addEventListener('click', () => setAiCategoryFilter(btn.dataset.cat));
  });

  aiStopBtn.addEventListener('click', () => {
    if (agentPool) { agentPool.stop(); agentPool = null; }
    aiRunning = false;
    aiStopBtn.style.display = 'none';
    aiPl.textContent = `\u23F9 LLM stopped \u2014 ${aiScores.size} scored so far`;
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

  dash.querySelector('#jr-back').addEventListener('click', () => {
    if (fetchCtrl) { fetchCtrl.abort(); fetchCtrl = null; }
    if (agentPool) { agentPool.stop(); agentPool = null; }
    showModeSelect(root, cfg);
  });

  dash.querySelector('#jr-csv').addEventListener('click', () => triggerDownload(buildCsv(filtered, cfg, aiScores), `journey-cleanup-filtered-${todayIso()}.csv`));
  dash.querySelector('#jr-csv-all').addEventListener('click', () => {
    const co = cutoff();
    const allStale = all.filter((j) => new Date(j.metadata?.lastModifiedAt) < co);
    triggerDownload(buildCsv(allStale, cfg, aiScores), `journey-cleanup-all-${todayIso()}.csv`);
  });
  dash.querySelector('#jr-reconfig').addEventListener('click', () => { showModal((nc) => showDashboard(root, nc)); });
  const refBtn = dash.querySelector('#jr-refresh');
  refBtn.addEventListener('click', () => {
    all = []; filtered = []; loading = true;
    errEl.style.display = 'none';
    pf.style.width = '0%';
    refBtn.disabled = true;
    aiScores.clear();
    aiPl.textContent = 'Waiting for fetch\u2026'; aiPf.style.width = '0%';
    aiCountsEl.style.display = 'none'; aiStopBtn.style.display = 'none';
    updSummary(); applyF(); startLoad();
  });

  // ── fetch controller ───────────────────────────────────────────────────────

  let fetchCtrl = null;

  stopBtn.addEventListener('click', () => {
    if (fetchCtrl) { fetchCtrl.abort(); fetchCtrl = null; }
    stopBtn.style.display = 'none'; loading = false; refBtn.disabled = false;
    setP(parseFloat(pf.style.width) || 0, `\u23F9 Stopped \u2014 ${all.length} loaded`);
    updSummary(); updOwnerFilter(); applyF();
  });

  function startLoad() {
    let totalPages = 0;
    aiScores.clear();
    stopBtn.style.display = 'inline-flex';
    setP(5, 'Fetching page 1\u2026');
    aiPl.textContent = 'Waiting for fetch\u2026'; aiPf.style.width = '0%';
    fetchCtrl = fetchAll(
      cfg,
      (chunk, cumul, pageNum, apiTotal) => {
        totalPages = Math.max(totalPages, pageNum + 1);
        all = cumul;
        const knownTotal = apiTotal || 0;
        const pct = knownTotal > 0
          ? Math.min(95, Math.round((cumul.length / knownTotal) * 100))
          : (totalPages > 1 ? Math.min(90, Math.round((pageNum / totalPages) * 85) + 5) : 50);
        const totalLabel = knownTotal > 0 ? ` / ${knownTotal}` : '';
        setP(pct, `\uD83D\uDCE5 ${cumul.length}${totalLabel} loaded\u2026`);
        // Apply rule scores instantly as each chunk arrives
        applyRuleScores(chunk);
        updSummary(); updOwnerFilter(); applyF();
      },
      (err) => showErr(`Fetch error: ${err.message}`),
      (final) => {
        fetchCtrl = null; all = final; loading = false; refBtn.disabled = false;
        stopBtn.style.display = 'none';
        setP(100, `\u2705 Done \u2014 ${final.length} journeys loaded`);
        applyRuleScores(final); // ensure all scored
        updSummary(); updOwnerFilter(); applyF();

        const co = cutoff();
        // Default: LLM on draft journeys only. "Include live" adds live/deployed journeys.
        const staleTargets = final.filter((j) => {
          if (!(new Date(j.metadata?.lastModifiedAt) < co)) return false;
          const s = (j.status || '').toLowerCase();
          if (s === 'draft') return true;
          if (includeLive && (s === 'live' || s === 'deployed')) return true;
          return false;
        });

        if (aiEnabled) {
          // LLM phase starts automatically after fetch — but only if proxy is reachable
          aiPl.textContent = `\uD83E\uDD16 Checking proxy before starting LLM\u2026`;
          testProxy().then((health) => {
            if (!health.ok) {
              aiPl.textContent = '\u26A0 AI proxy is offline \u2014 LLM scoring skipped.';
              showProxyDownBanner(health.error || 'Connection refused or unreachable');
              return;
            }
            aiPl.textContent = `\uD83E\uDD16 Fetch done \u2014 starting LLM on ${staleTargets.length} journeys\u2026`;
            startAI(staleTargets);
          });
        } else {
          // Rule-only mode: show instant summary
          let retire = 0; let review = 0; let keep = 0;
          staleTargets.forEach((j) => {
            const e = aiScores.get(j.id);
            if (!e) return;
            if (e.rule.score >= 80) retire += 1;
            else if (e.rule.score >= 50) review += 1;
            else keep += 1;
          });
          aiCountsEl.style.display = 'flex';
          dash.querySelector('#jcc-ai-retire').textContent = `\uD83D\uDD34 ${retire} Delete`;
          dash.querySelector('#jcc-ai-review').textContent = `\uD83D\uDFE1 ${review} Review`;
          dash.querySelector('#jcc-ai-keep').textContent = `\uD83D\uDFE2 ${keep} Keep`;
          aiPf.style.width = '100%';
          aiPl.textContent = `\u2705 Rule scoring complete \u2014 ${staleTargets.length} journeys`;
          // Auto-save rule-only snapshot
          if (!snapshotSaved) {
            snapshotSaved = true;
            saveSnapshot(cfg.sandbox, final, aiScores)
              .then(() => { aiPl.textContent += ' \u2014 \uD83D\uDCBE Saved to cache'; })
              .catch(() => { /* ignore */ });
          }
        }
      },
    );
  }

  // Snap info button — re-run fresh analysis
  dash.querySelector('#jcc-snap-info .jcc-snap-refresh')?.addEventListener('click', () => showDashboard(root, cfg));

  // If loaded from cache, skip startLoad and render directly
  if (initialJourneys) {
    loading = false;
    setP(100, `\u2705 ${initialJourneys.length} journeys (from cache)`);
    aiPf.style.width = '100%';
    aiPl.textContent = `\u2705 ${aiScores.size} journeys scored (from cache)`;
    if (aiScores.size) {
      aiCountsEl.style.display = 'flex';
      // Compute Delete / Review / Keep counts — only for journeys with a successful LLM result,
      // matching the same population that onProgress reports during a live run.
      let retire = 0; let review = 0; let keep = 0;
      aiScores.forEach((entry) => {
        const { rule, llm } = entry;
        if (!rule || !llm || llm.error) return; // skip rule-only or failed LLM entries
        const score = Math.round(rule.score * 0.4 + (llm.retirementScore || 0) * 0.6);
        if (score >= 80) retire += 1;
        else if (score >= 50) review += 1;
        else keep += 1;
      });
      dash.querySelector('#jcc-ai-retire').textContent = `\uD83D\uDD34 ${retire} Delete`;
      dash.querySelector('#jcc-ai-review').textContent = `\uD83D\uDFE1 ${review} Review`;
      dash.querySelector('#jcc-ai-keep').textContent = `\uD83D\uDFE2 ${keep} Keep`;
    }
    updSummary(); updOwnerFilter(); applyF();
    dash.querySelector('#jr-refresh').disabled = false;
    return;
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
  wrap.querySelector('.jcc-pre-open-cfg').addEventListener('click', () => { showModal((nc) => showModeSelect(root, nc)); });
}

// ─── EDS entry point ─────────────────────────────────────────────────────────

function initApp(root) {
  const blockCfg = readCfg(root);
  const hasCfg = blockCfg.token && blockCfg.apiKey && blockCfg.orgId && blockCfg.sandbox;
  const saved = getSaved();
  const hasSaved = saved.token && saved.apiKey && saved.orgId && saved.sandbox;
  const cfg = hasCfg ? blockCfg : (hasSaved ? saved : null);
  if (cfg) { showModeSelect(root, cfg); }
  else { showPreDash(root); showModal((nc) => showModeSelect(root, nc)); }
}

export default function decorate(block) {
  block.innerHTML = '';
  initApp(block);
}
