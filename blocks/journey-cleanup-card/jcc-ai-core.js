/* AI scoring core — rule engine + LLM proxy + agent pool */
/* exported: computeRuleScore, isDefaultJourneyName, scoreBadgeHtml, aiDetailHtml,
             scoreSingleLLM, checkProxyHealth, createAgentPool, fetchJourneyDetail */

const AJO_BASE_AI = 'https://platform.adobe.io/ajo/journey';
const AI_AGENT_CONCURRENCY = 4;
const DEFAULT_NAME_RE = /^Journey\s*[\-_]?\s*\d+\s*(v\d+)?$/i;

export function isDefaultJourneyName(name) {
  return !!name && DEFAULT_NAME_RE.test(name.trim());
}

export function daysAgoAI(iso) {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

export function computeRuleScore(journey) {
  const days = daysAgoAI(journey.metadata?.lastModifiedAt);
  const name = journey.name || '';
  const status = (journey.status || '').toLowerCase();
  const version = parseInt(journey.version || '1', 10);
  const createdBy = journey.metadata?.createdBy || '';
  const modifiedBy = journey.metadata?.lastModifiedBy || '';
  let score = 0;
  const signals = [];

  if (isDefaultJourneyName(name)) {
    score += 25;
    signals.push({ label: 'AJO default name (never renamed)', points: 25, type: 'critical' });
  }

  const badWords = /\b(test|copy|old|tmp|temp|backup|delete|unused|demo|sample|draft|v1|v2|v3|poc|prototype|placeholder|dummy)\b/i;
  if (!isDefaultJourneyName(name) && badWords.test(name)) {
    score += 20;
    signals.push({ label: 'Name contains stale indicator (test/copy/old\u2026)', points: 20, type: 'warning' });
  }

  if (days > 180) { score += 35; signals.push({ label: `${days} days stale (>180d)`, points: 35, type: 'critical' }); }
  else if (days > 120) { score += 25; signals.push({ label: `${days} days stale (>120d)`, points: 25, type: 'warning' }); }
  else if (days > 90) { score += 15; signals.push({ label: `${days} days stale (>90d)`, points: 15, type: 'warning' }); }
  else if (days > 60) { score += 8; signals.push({ label: `${days} days stale (>60d)`, points: 8, type: 'ok' }); }

  if (status === 'failed') { score += 15; signals.push({ label: 'Status: failed', points: 15, type: 'warning' }); }
  else if (status === 'draft') { score += 12; signals.push({ label: 'Status: draft', points: 12, type: 'warning' }); }
  else if (status === 'stopped' || status === 'closed') { score += 8; signals.push({ label: `Status: ${status}`, points: 8, type: 'ok' }); }

  if (version <= 1) { score += 8; signals.push({ label: 'Version 1 (never iterated)', points: 8, type: 'ok' }); }

  const s = Math.min(100, score);
  const label = s >= 80 ? 'Safe to Retire' : s >= 50 ? 'Review First' : 'Likely Active';
  const color = s >= 80 ? 'red' : s >= 50 ? 'yellow' : 'green';
  return { score: s, signals, label, color };
}

export async function fetchJourneyDetail(cfg, id) {
  const res = await fetch(`${AJO_BASE_AI}/${id}`, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'x-api-key': cfg.apiKey,
      'x-gw-ims-org-id': cfg.orgId,
      'x-sandbox-name': cfg.sandbox,
    },
  });
  if (!res.ok) throw new Error(`Detail API HTTP ${res.status}`);
  return res.json();
}

export async function scoreSingleLLM(journey, proxyUrl, timeoutMs = 90_000) {
  const enriched = {
    ...journey,
    _daysStale: daysAgoAI(journey.metadata?.lastModifiedAt),
    _isDefaultName: isDefaultJourneyName(journey.name),
  };
  const res = await fetch(`${proxyUrl}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ journey: enriched }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) { const txt = await res.text().catch(() => ''); throw new Error(`Proxy ${res.status}: ${txt.slice(0, 200)}`); }
  return res.json();
}

export async function checkProxyHealth(proxyUrl) {
  try {
    const res = await fetch(`${proxyUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: data.status === 'ok', model: data.model };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function fetchTokenStats(proxyUrl) {
  try {
    const res = await fetch(`${proxyUrl}/stats`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return res.json();
  } catch (_) { return null; }
}

const PROXY_DOWN_THRESHOLD = 3; // consecutive failures before declaring proxy down

export function createAgentPool({
  cfg, proxyUrl, concurrency = AI_AGENT_CONCURRENCY, detailCache,
  onScore, onProgress, onComplete, onProxyDown,
}) {
  const queue = [];
  let done = 0; let total = 0; let stopped = false;
  let retireCount = 0; let reviewCount = 0; let keepCount = 0;
  let consecutiveFails = 0; let proxyDownFired = false;

  function tally(rule, llm) {
    const s = llm && !llm.error
      ? Math.round(rule.score * 0.4 + (llm.retirementScore || 0) * 0.6)
      : rule.score;
    if (s >= 80) retireCount += 1; else if (s >= 50) reviewCount += 1; else keepCount += 1;
  }

  async function processOne(j) {
    if (stopped) return;
    const rule = computeRuleScore(j);
    let detail = null; let llm = null;
    try {
      detail = detailCache.has(j.id) ? detailCache.get(j.id) : await fetchJourneyDetail(cfg, j.id);
      detailCache.set(j.id, detail);
    } catch (_) { /* metadata only */ }
    try {
      llm = await scoreSingleLLM(detail ? { ...j, ...detail } : j, proxyUrl);
      consecutiveFails = 0; // reset on success
    } catch (e) {
      consecutiveFails += 1;
      const isTimeout = e.name === 'AbortError' || e.name === 'TimeoutError';
      llm = { error: isTimeout ? 'Request timed out — proxy may be overloaded' : e.message };
      // Detect proxy down after N consecutive failures
      if (consecutiveFails >= PROXY_DOWN_THRESHOLD && !proxyDownFired && onProxyDown) {
        proxyDownFired = true;
        onProxyDown(e.message);
      }
    }
    tally(rule, llm);
    done += 1;
    onScore(j.id, rule, llm);
    onProgress({ done, total, retireCount, reviewCount, keepCount });
    if (done === total) onComplete();
  }

  async function worker() {
    while (queue.length && !stopped) {
      const j = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      try { await processOne(j); } catch (_) { /* swallow unexpected errors */ }
    }
  }

  return {
    enqueue(journeys) {
      total = journeys.length; done = 0; retireCount = 0; reviewCount = 0; keepCount = 0;
      stopped = false; consecutiveFails = 0; proxyDownFired = false;
      queue.length = 0; queue.push(...journeys);
      const n = Math.min(concurrency, journeys.length);
      for (let i = 0; i < n; i += 1) worker();
    },
    stop() { stopped = true; queue.length = 0; },
    resetProxyDown() { consecutiveFails = 0; proxyDownFired = false; },
  };
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function escAI(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Journey type → display label + CSS modifier
const JOURNEY_TYPE_META = {
  'Welcome':        { icon: '👋', mod: 'welcome' },
  'Promotional':    { icon: '📣', mod: 'promo' },
  'Transactional':  { icon: '🧾', mod: 'transact' },
  'Re-engagement':  { icon: '🔄', mod: 'reengage' },
  'Abandoned Cart': { icon: '🛒', mod: 'abandoned' },
  'Onboarding':     { icon: '🚀', mod: 'onboard' },
  'Retention':      { icon: '🤝', mod: 'retention' },
  'Test/POC':       { icon: '🧪', mod: 'test' },
  'Unknown':        { icon: '❓', mod: 'unknown' },
};

// Lifecycle stage → icon + CSS modifier
const LIFECYCLE_STAGE_META = {
  'Acquisition':   { icon: '🎯', mod: 'acquisition' },
  'Onboarding':    { icon: '🚀', mod: 'onboard' },
  'Activation':    { icon: '⚡', mod: 'activation' },
  'Retention':     { icon: '🤝', mod: 'retention' },
  'Re-engagement': { icon: '🔄', mod: 'reengage' },
  'Monetization':  { icon: '💰', mod: 'monetize' },
  'Post-purchase': { icon: '📦', mod: 'postpurchase' },
  'Loyalty':       { icon: '⭐', mod: 'loyalty' },
  'Unknown':       { icon: '❓', mod: 'unknown' },
};

function lifecycleStageBadgeHtml(stage) {
  if (!stage) return '';
  // Normalise compound stages like "Onboarding / First activation" → first word
  const key = Object.keys(LIFECYCLE_STAGE_META).find((k) => stage.startsWith(k)) || 'Unknown';
  const meta = LIFECYCLE_STAGE_META[key] || { icon: '📍', mod: 'unknown' };
  return `<span class="jcc-lifecycle-badge jcc-lifecycle-${escAI(meta.mod)}" title="${escAI(stage)}">${meta.icon} ${escAI(stage)}</span>`;
}

export function journeyTypeBadgeHtml(llm) {
  if (!llm || !llm.journeyType) return '';
  const t = llm.journeyType;
  const meta = JOURNEY_TYPE_META[t] || { icon: '📋', mod: 'unknown' };
  const tip = llm.useCaseSummary ? escAI(llm.useCaseSummary) : escAI(t);
  return `<span class="jcc-jtype-badge jcc-jtype-${meta.mod}" title="${tip}">${meta.icon} ${escAI(t)}</span>`;
}

export function scoreBadgeHtml(rule, llm, pending) {
  if (pending) return '<span class="jcc-ai-analyzing">\u23F3 Analyzing\u2026</span>';
  if (!rule) return '<span class="jcc-ai-pending">\u2014</span>';
  let s; let label; let tip;
  if (llm && !llm.error) {
    s = Math.round(rule.score * 0.4 + (llm.retirementScore || 0) * 0.6);
    label = llm.retirementLabel || rule.label;
    tip = `AI+Rule: ${s}/100 (confidence: ${llm.confidence || '?'}%)`;
  } else { s = rule.score; label = rule.label; tip = `Rule-based: ${s}/100`; }
  const color = s >= 80 ? 'red' : s >= 50 ? 'yellow' : 'green';
  const icon = color === 'red' ? '\uD83D\uDD34' : color === 'yellow' ? '\uD83D\uDFE1' : '\uD83D\uDFE2';
  return `<span class="jcc-score-badge jcc-score-${color}" title="${escAI(tip)}">${icon} ${s}% <span class="jcc-score-lbl">${escAI(label)}</span></span>`;
}

export function aiDetailHtml(rule, llm) {
  if (!rule) return '';
  let html = '<div class="jcc-ai-detail"><div class="jcc-ai-detail-hdr"><span>&#x1F916;</span> AI Risk Analysis</div>';
  if (rule.signals.length) {
    html += '<div class="jcc-ai-signals"><div class="jcc-ai-signals-lbl">Rule Signals</div>';
    rule.signals.forEach((sig) => {
      html += `<div class="jcc-ai-signal jcc-ai-sig-${escAI(sig.type)}">`;
      html += `<span class="jcc-ai-sig-pts">+${sig.points}</span>`;
      html += `<span class="jcc-ai-sig-lbl">${escAI(sig.label)}</span></div>`;
    });
    html += `<div class="jcc-ai-rule-total">Rule Score: <strong>${rule.score}/100</strong></div></div>`;
  }
  if (llm && !llm.error) {
    const fs = Math.round(rule.score * 0.4 + (llm.retirementScore || 0) * 0.6);
    html += '<div class="jcc-ai-llm-panel">';

    // ── Business Intent Block (new) ───────────────────────────────────────
    const hasIntent = llm.lifecycleStage || llm.customerExperience || llm.behaviorTargeted
      || llm.businessObjective || llm.whyTeamBuiltThis;

    if (hasIntent) {
      html += '<div class="jcc-ai-intent-block">';
      html += '<div class="jcc-ai-intent-hdr">🎯 Business Intent</div>';

      // Lifecycle stage + journey type badges on same row
      if (llm.lifecycleStage || llm.journeyType) {
        html += '<div class="jcc-ai-intent-badges">';
        if (llm.lifecycleStage) html += lifecycleStageBadgeHtml(llm.lifecycleStage);
        if (llm.journeyType) {
          const meta = JOURNEY_TYPE_META[llm.journeyType] || { icon: '📋', mod: 'unknown' };
          html += `<span class="jcc-jtype-badge jcc-jtype-${escAI(meta.mod)}" title="${escAI(llm.useCaseSummary || llm.journeyType)}">${meta.icon} ${escAI(llm.journeyType)}</span>`;
        }
        html += '</div>';
      }

      if (llm.customerExperience) {
        html += `<div class="jcc-ai-intent-row"><span class="jcc-ai-intent-lbl">Customer experience</span><span class="jcc-ai-intent-val">${escAI(llm.customerExperience)}</span></div>`;
      }
      if (llm.behaviorTargeted) {
        html += `<div class="jcc-ai-intent-row"><span class="jcc-ai-intent-lbl">Behavior targeted</span><span class="jcc-ai-intent-val">${escAI(llm.behaviorTargeted)}</span></div>`;
      }
      if (llm.businessObjective) {
        html += `<div class="jcc-ai-intent-row"><span class="jcc-ai-intent-lbl">Business objective</span><span class="jcc-ai-intent-val">${escAI(llm.businessObjective)}</span></div>`;
      }
      if (llm.whyTeamBuiltThis) {
        html += `<div class="jcc-ai-intent-row jcc-ai-intent-why"><span class="jcc-ai-intent-lbl">Why team built this</span><span class="jcc-ai-intent-val">${escAI(llm.whyTeamBuiltThis)}</span></div>`;
      }
      html += '</div>';
    } else if (llm.journeyType || llm.useCaseSummary || llm.targetAudience) {
      // Fallback: old-style use case block if new intent fields absent
      html += '<div class="jcc-ai-usecase">';
      if (llm.journeyType) {
        const meta = JOURNEY_TYPE_META[llm.journeyType] || { icon: '📋', mod: 'unknown' };
        html += `<div class="jcc-ai-usecase-type"><span class="jcc-jtype-badge jcc-jtype-${escAI(meta.mod)}">${meta.icon} ${escAI(llm.journeyType)}</span></div>`;
      }
      if (llm.useCaseSummary) {
        html += `<div class="jcc-ai-usecase-summary"><span class="jcc-ai-usecase-lbl">What it does:</span> ${escAI(llm.useCaseSummary)}</div>`;
      }
      if (llm.targetAudience) {
        html += `<div class="jcc-ai-usecase-audience"><span class="jcc-ai-usecase-lbl">Target audience:</span> ${escAI(llm.targetAudience)}</div>`;
      }
      html += '</div>';
    }

    // ── Use case summary (always shown when present) ───────────────────────
    if (llm.useCaseSummary && hasIntent) {
      html += `<div class="jcc-ai-usecase-summary jcc-ai-usecase-summary--intent"><span class="jcc-ai-usecase-lbl">Summary:</span> ${escAI(llm.useCaseSummary)}</div>`;
    }
    if (llm.targetAudience && hasIntent) {
      html += `<div class="jcc-ai-usecase-audience"><span class="jcc-ai-usecase-lbl">Target audience:</span> ${escAI(llm.targetAudience)}</div>`;
    }

    html += `<div class="jcc-ai-llm-row">`;
    html += `<span class="jcc-ai-llm-lbl">Business Value</span><span class="jcc-ai-biz-${escAI(llm.businessValue || 'low')}">${escAI(llm.businessValue || '\u2014')}</span>`;
    html += `<span class="jcc-ai-llm-lbl">LLM Score</span><strong>${llm.retirementScore || '?'}/100</strong>`;
    html += `<span class="jcc-ai-llm-lbl">Combined</span><strong>${fs}/100</strong>`;
    html += `<span class="jcc-ai-llm-lbl">Confidence</span><span>${llm.confidence || '?'}%</span></div>`;
    if (llm.businessPurpose) html += `<div class="jcc-ai-purpose"><strong>Business Purpose:</strong> ${escAI(llm.businessPurpose)}</div>`;
    if (llm.reasoning) html += `<div class="jcc-ai-reasoning">${escAI(llm.reasoning)}</div>`;
    const rc = llm.retirementLabel && llm.retirementLabel.toLowerCase().includes('retire') ? 'jcc-ai-rec-retire'
      : llm.retirementLabel && llm.retirementLabel.toLowerCase().includes('keep') ? 'jcc-ai-rec-keep' : 'jcc-ai-rec-review';
    html += `<div class="jcc-ai-recommendation ${rc}"><strong>Recommendation:</strong> ${escAI(llm.recommendation || llm.retirementLabel || '\u2014')}</div>`;
    html += '</div>';
  } else if (llm && llm.error) {
    html += `<div class="jcc-ai-err-note">&#x26A0; LLM failed: ${escAI(llm.error)} \u2014 rule-based score only.</div>`;
  }
  html += '</div>';
  return html;
}
