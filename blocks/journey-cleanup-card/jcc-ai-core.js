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
    score += 10;
    signals.push({ label: 'Name contains stale indicator (weak contextual signal)', points: 10, type: 'warning' });
  }

  if (days > 180) { score += 35; signals.push({ label: `${days} days stale (>180d)`, points: 35, type: 'critical' }); }
  else if (days > 120) { score += 25; signals.push({ label: `${days} days stale (>120d)`, points: 25, type: 'warning' }); }
  else if (days > 90) { score += 15; signals.push({ label: `${days} days stale (>90d)`, points: 15, type: 'warning' }); }
  else if (days > 60) { score += 8; signals.push({ label: `${days} days stale (>60d)`, points: 8, type: 'ok' }); }

  if (status === 'failed') { score += 15; signals.push({ label: 'Status: failed', points: 15, type: 'warning' }); }
  else if (status === 'draft') { score += 7; signals.push({ label: 'Status: draft (not deployed yet)', points: 7, type: 'warning' }); }
  else if (status === 'stopped' || status === 'closed') { score += 8; signals.push({ label: `Status: ${status}`, points: 8, type: 'ok' }); }

  if (version <= 1) { score += 8; signals.push({ label: 'Version 1 (never iterated)', points: 8, type: 'ok' }); }

  const s = Math.min(100, score);
  const label = s >= 80 ? 'Safe to Delete' : s >= 50 ? 'Review First' : 'Likely Active';
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

export async function resolveAudiences(audiences, cfg, proxyUrl, timeoutMs = 60_000) {
  if (!Array.isArray(audiences) || !audiences.length) return [];
  if (!cfg || !cfg.token) return []; // no credentials — skip silently
  try {
    const res = await fetch(`${proxyUrl}/audience/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audiences, cfg }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return audiences; // fallback: return raw unresolved list
    const { resolved } = await res.json();
    return Array.isArray(resolved) ? resolved : audiences;
  } catch (_) {
    return audiences; // graceful fallback — scoring continues without audience enrichment
  }
}

export async function scoreSingleLLM(journey, proxyUrl, timeoutMs = 360_000) {
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
    const res = await fetch(`${proxyUrl}/health`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: data.status === 'ok', model: data.model };
  } catch (e) {
    // AbortSignal.timeout() fires a DOMException with name 'TimeoutError' and
    // message 'signal timed out' — surface a clearer message for the UI banner.
    const msg = e.name === 'TimeoutError'
      ? 'Health check timed out (proxy may be slow to respond — check it is running)'
      : e.message;
    return { ok: false, error: msg };
  }
}

export async function fetchTokenStats(proxyUrl) {
  try {
    const res = await fetch(`${proxyUrl}/stats`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return res.json();
  } catch (_) { return null; }
}

const PROXY_DOWN_THRESHOLD = 5; // consecutive failures before declaring proxy down

export function createAgentPool({
  cfg, proxyUrl, concurrency = AI_AGENT_CONCURRENCY, detailCache,
  onScore, onProgress, onComplete, onProxyDown,
}) {
  const queue = [];
  let done = 0; let total = 0; let stopped = false;
  let retireCount = 0; let reviewCount = 0; let keepCount = 0;
  let consecutiveFails = 0; let proxyDownFired = false;

  function tally(rule, llm) {
    let s;
    if (llm && !llm.error) {
      // High-value journeys: LLM evidence dominates (80%) over rule heuristics (20%)
      // to prevent staleness/naming penalties from overriding strong business intent signals.
      const isHighValue = llm.businessValue === 'high' && (llm.retirementScore || 100) <= 40;
      const ruleWeight = isHighValue ? 0.2 : 0.4;
      const llmWeight  = isHighValue ? 0.8 : 0.6;
      s = Math.round(rule.score * ruleWeight + (llm.retirementScore || 0) * llmWeight);
    } else {
      s = rule.score;
    }
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

    // Agent 1 — Audience Resolver
    // Merge audiences from list + detail, resolve via proxy, inject plain-English descriptions.
    const mergedJourney = detail ? { ...j, ...detail } : j;
    const rawAudiences = mergedJourney.audiences || [];
    let enrichedAudiences = rawAudiences;
    if (rawAudiences.length && cfg) {
      try {
        enrichedAudiences = await resolveAudiences(rawAudiences, cfg, proxyUrl);
      } catch (_) { /* graceful fallback — continue with raw names */ }
    }

    // Agent 2 — Journey Scorer (receives enriched audience context)
    try {
      llm = await scoreSingleLLM(
        { ...mergedJourney, audiences: enrichedAudiences },
        proxyUrl,
      );
      consecutiveFails = 0; // reset on success
    } catch (e) {
      const isTimeout = e.name === 'AbortError' || e.name === 'TimeoutError';
      llm = { error: isTimeout ? 'LLM timed out — Ollama is slow, proxy is still running. Retry later.' : e.message };
      // Only count connection errors (proxy truly down) toward the down threshold.
      // Timeouts mean Ollama is slow but the proxy itself is alive — don't trigger false "proxy down" banner.
      if (!isTimeout) {
        consecutiveFails += 1;
        if (consecutiveFails >= PROXY_DOWN_THRESHOLD && !proxyDownFired && onProxyDown) {
          proxyDownFired = true;
          onProxyDown(e.message);
        }
      }
    }
    // Attach resolved audience info to LLM result for UI rendering
    if (llm && !llm.error && enrichedAudiences && enrichedAudiences.length && enrichedAudiences[0].plainEnglish) {
      llm._resolvedAudiences = enrichedAudiences.map((a) => ({
        id: a.id, name: a.name, plainEnglish: a.plainEnglish, status: a.apiStatus,
      }));
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
    // Append additional journeys to an already-running pool without resetting progress counters.
    // Used when "Include live journeys" is toggled mid-run to add live/deployed journeys.
    addMore(journeys) {
      if (!journeys.length) return;
      total += journeys.length;
      queue.push(...journeys);
      // Spawn extra workers up to concurrency limit (existing workers may already be draining)
      const active = Math.min(concurrency, journeys.length);
      for (let i = 0; i < active; i += 1) worker();
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

// Shared combined-score calculator — mirrors tally() weight logic so badge + detail are consistent.
function combinedScore(rule, llm) {
  if (!llm || llm.error) return rule.score;
  const isHighValue = llm.businessValue === 'high' && (llm.retirementScore || 100) <= 40;
  const ruleWeight  = isHighValue ? 0.2 : 0.4;
  const llmWeight   = isHighValue ? 0.8 : 0.6;
  return Math.round(rule.score * ruleWeight + (llm.retirementScore || 0) * llmWeight);
}

export function scoreBadgeHtml(rule, llm, pending) {
  if (pending) return '<span class="jcc-ai-analyzing">\u23F3 Analyzing\u2026</span>';
  if (!rule) return '<span class="jcc-ai-pending">\u2014</span>';
  let s; let label; let tip;
  if (llm && !llm.error) {
    s = combinedScore(rule, llm);
    label = llm.lifecycleDecision ? llm.lifecycleDecision : (llm.retirementLabel || rule.label);
    tip = `AI+Rule: ${s}/100 (confidence: ${llm.confidence || '?'}%)`;
  } else { s = rule.score; label = rule.label; tip = `Rule-based: ${s}/100`; }
  const color = s >= 80 ? 'red' : s >= 50 ? 'yellow' : 'green';
  const icon = color === 'red' ? '\uD83D\uDD34' : color === 'yellow' ? '\uD83D\uDFE1' : '\uD83D\uDFE2';
  return `<span class="jcc-score-badge jcc-score-${color}" title="${escAI(tip)}">${icon} ${s}% <span class="jcc-score-lbl">${escAI(label)}</span></span>`;
}

export function aiDetailHtml(rule, llm) {
  if (!rule) return '';

  // ── Verdict: pick the single best label + score ───────────────────────────
  const hasLlm = llm && !llm.error;
  const fs = hasLlm ? combinedScore(rule, llm) : rule.score;
  const verdictLabel = hasLlm
    ? (llm.lifecycleDecision || llm.retirementLabel || rule.label)
    : rule.label;
  const verdictColor = fs >= 80 ? 'red' : fs >= 50 ? 'yellow' : 'green';
  const verdictIcon = verdictColor === 'red' ? '🔴' : verdictColor === 'yellow' ? '🟡' : '🟢';
  const confText = hasLlm && llm.confidence ? `${llm.confidence}% confidence` : 'Rule-based';
  const bizVal = hasLlm && llm.businessValue ? llm.businessValue : null;
  const bizCls = bizVal === 'high' ? 'jcc-ai-biz-high' : bizVal === 'medium' ? 'jcc-ai-biz-medium' : 'jcc-ai-biz-low';

  // ── Section 1 content: What this journey does ─────────────────────────────
  function sec1Html() {
    let s = '';
    const hasIntent = hasLlm && (llm.lifecycleStage || llm.customerExperience
      || llm.behaviorTargeted || llm.businessObjective || llm.whyTeamBuiltThis);

    // Badges row
    if (hasLlm && (llm.lifecycleStage || llm.journeyType)) {
      s += '<div class="jcc-ai-intent-badges">';
      if (llm.lifecycleStage) s += lifecycleStageBadgeHtml(llm.lifecycleStage);
      if (llm.journeyType) {
        const meta = JOURNEY_TYPE_META[llm.journeyType] || { icon: '📋', mod: 'unknown' };
        s += `<span class="jcc-jtype-badge jcc-jtype-${escAI(meta.mod)}" title="${escAI(llm.useCaseSummary || llm.journeyType)}">${meta.icon} ${escAI(llm.journeyType)}</span>`;
      }
      s += '</div>';
    }

    // Summary (once)
    if (hasLlm && llm.useCaseSummary) {
      s += `<div class="jcc-ais1-summary">${escAI(llm.useCaseSummary)}</div>`;
    }

    // Intent rows (only when present)
    if (hasIntent) {
      s += '<div class="jcc-ais1-rows">';
      if (llm.targetAudience) {
        s += `<div class="jcc-ai-intent-row"><span class="jcc-ai-intent-lbl">Audience</span><span class="jcc-ai-intent-val">${escAI(llm.targetAudience)}</span></div>`;
      }
      if (llm.customerExperience) {
        s += `<div class="jcc-ai-intent-row"><span class="jcc-ai-intent-lbl">Customer experience</span><span class="jcc-ai-intent-val">${escAI(llm.customerExperience)}</span></div>`;
      }
      if (llm.behaviorTargeted) {
        s += `<div class="jcc-ai-intent-row"><span class="jcc-ai-intent-lbl">Behavior targeted</span><span class="jcc-ai-intent-val">${escAI(llm.behaviorTargeted)}</span></div>`;
      }
      if (llm.businessObjective) {
        s += `<div class="jcc-ai-intent-row"><span class="jcc-ai-intent-lbl">Business objective</span><span class="jcc-ai-intent-val">${escAI(llm.businessObjective)}</span></div>`;
      }
      if (llm.whyTeamBuiltThis) {
        s += `<div class="jcc-ai-intent-row jcc-ai-intent-why"><span class="jcc-ai-intent-lbl">Why it was built</span><span class="jcc-ai-intent-val">${escAI(llm.whyTeamBuiltThis)}</span></div>`;
      }
      s += '</div>';
    } else if (!hasLlm) {
      s += '<p class="jcc-ais1-no-llm">AI not yet run — rule-based score only.</p>';
    }
    return s;
  }

  // ── Section 2 content: Why AI thinks this ────────────────────────────────
  function sec2Html() {
    let s = '';
    if (!hasLlm) {
      s += '<p class="jcc-ais1-no-llm">LLM analysis not available.</p>';
      return s;
    }

    // Score bar
    const barPct = Math.min(100, fs);
    const barCls = verdictColor === 'red' ? 'jcc-score-bar-red' : verdictColor === 'yellow' ? 'jcc-score-bar-yellow' : 'jcc-score-bar-green';
    s += `<div class="jcc-score-bar-wrap">`;
    s += `  <div class="jcc-score-bar-track"><div class="jcc-score-bar-fill ${barCls}" style="width:${barPct}%"></div></div>`;
    s += `  <span class="jcc-score-bar-num">${fs}/100</span>`;
    s += `</div>`;

    // Business value chip + confidence
    s += '<div class="jcc-ais2-meta">';
    if (bizVal) s += `<span class="jcc-ais2-chip ${bizCls}">Business value: <strong>${escAI(bizVal)}</strong></span>`;
    if (llm.governanceReviewPriority) {
      const gpCls = llm.governanceReviewPriority.toLowerCase() === 'low' ? 'jcc-ai-gov-low'
        : llm.governanceReviewPriority.toLowerCase() === 'high' ? 'jcc-ai-gov-high' : 'jcc-ai-gov-medium';
      s += `<span class="jcc-ai-gov-priority ${gpCls}">Review priority: <strong>${escAI(llm.governanceReviewPriority)}</strong></span>`;
    }
    s += '</div>';

    // Reasoning (once — replaces both businessPurpose and reasoning duplication)
    const reasonText = llm.reasoning || llm.businessPurpose || '';
    if (reasonText) {
      s += `<div class="jcc-ai-reasoning">${escAI(reasonText)}</div>`;
    }

    // Recommendation callout (single)
    const recText = llm.recommendation || llm.retirementLabel || verdictLabel;
    const recCls = verdictColor === 'red' ? 'jcc-ai-rec-retire'
      : verdictColor === 'green' ? 'jcc-ai-rec-keep' : 'jcc-ai-rec-review';
    s += `<div class="jcc-ai-recommendation ${recCls}">&#x2192; ${escAI(recText)}</div>`;

    return s;
  }

  // ── Section 3 content: Rule signals ──────────────────────────────────────
  function sec3Html() {
    let s = '';
    if (rule.signals.length) {
      s += '<div class="jcc-ai-signals">';
      rule.signals.forEach((sig) => {
        s += `<div class="jcc-ai-signal jcc-ai-sig-${escAI(sig.type)}">`;
        s += `<span class="jcc-ai-sig-pts">+${sig.points}</span>`;
        s += `<span class="jcc-ai-sig-lbl">${escAI(sig.label)}</span></div>`;
      });
      s += '</div>';
    } else {
      s += '<p class="jcc-ais1-no-llm">No rule signals fired.</p>';
    }
    if (hasLlm) {
      s += `<div class="jcc-ais3-scores">`;
      s += `<span>Rule: <strong>${rule.score}/100</strong></span>`;
      s += `<span>LLM: <strong>${llm.retirementScore || '?'}/100</strong></span>`;
      s += `<span>Combined: <strong>${fs}/100</strong></span>`;
      s += `</div>`;
    }
    return s;
  }

  // ── Assemble ──────────────────────────────────────────────────────────────
  let html = '<div class="jcc-ai-detail">';

  // Always-visible header with gradient title bar
  html += '<div class="jcc-ai-detail-hdr"><span>&#x1F916;</span> AI Risk Analysis</div>';

  // Always-visible verdict bar
  html += `<div class="jcc-ai-verdict-bar jcc-verdict-${verdictColor}">`;
  html += `  <span class="jcc-verdict-icon">${verdictIcon}</span>`;
  html += `  <span class="jcc-verdict-score">${fs}</span>`;
  html += `  <span class="jcc-verdict-label">${escAI(verdictLabel)}</span>`;
  html += `  <span class="jcc-verdict-conf">${escAI(confText)}</span>`;
  html += `</div>`;

  if (llm && llm.error) {
    html += `<div class="jcc-ai-err-note">&#x26A0; LLM failed: ${escAI(llm.error)} \u2014 rule-based score shown.</div>`;
  }

  // Section 1 — What this journey does
  html += `<details class="jcc-ai-section" open>`;
  html += `  <summary class="jcc-ai-section-sum"><span class="jcc-ai-sec-num">1</span> What this journey does</summary>`;
  html += `  <div class="jcc-ai-section-body">${sec1Html()}</div>`;
  html += `</details>`;

  // Section 2 — Why the AI thinks this (only when LLM available)
  html += `<details class="jcc-ai-section">`;
  html += `  <summary class="jcc-ai-section-sum"><span class="jcc-ai-sec-num">2</span> Why the AI thinks this</summary>`;
  html += `  <div class="jcc-ai-section-body">${sec2Html()}</div>`;
  html += `</details>`;

  // Section 3 — Rule signals
  html += `<details class="jcc-ai-section">`;
  html += `  <summary class="jcc-ai-section-sum"><span class="jcc-ai-sec-num">3</span> Rule signals</summary>`;
  html += `  <div class="jcc-ai-section-body">${sec3Html()}</div>`;
  html += `</details>`;

  html += '</div>';
  return html;
}
