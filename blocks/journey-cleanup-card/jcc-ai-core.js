/* AI scoring core — rule engine + LLM proxy + agent pool */
/* exported: computeRuleScore, isDefaultJourneyName, scoreBadgeHtml, aiDetailHtml,
             scoreSingleLLM, checkProxyHealth, createAgentPool, fetchJourneyDetail */

const AJO_BASE_AI = 'https://platform.adobe.io/ajo/journey';
const AI_AGENT_CONCURRENCY = 4;
const DEFAULT_NAME_RE = /^Journey[\s\-_0-9a-zA-Z]*$/i;

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
  if (createdBy && modifiedBy && createdBy === modifiedBy) { score += 8; signals.push({ label: 'Single owner (possible orphan)', points: 8, type: 'ok' }); }

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

export async function scoreSingleLLM(journey, proxyUrl) {
  const enriched = {
    ...journey,
    _daysStale: daysAgoAI(journey.metadata?.lastModifiedAt),
    _isDefaultName: isDefaultJourneyName(journey.name),
  };
  const res = await fetch(`${proxyUrl}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ journey: enriched }),
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

export function createAgentPool({ cfg, proxyUrl, concurrency = AI_AGENT_CONCURRENCY, detailCache, onScore, onProgress, onComplete }) {
  const queue = [];
  let done = 0; let total = 0; let stopped = false;
  let retireCount = 0; let reviewCount = 0; let keepCount = 0;

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
    try { llm = await scoreSingleLLM(detail ? { ...j, ...detail } : j, proxyUrl); } catch (_) { /* rule only */ }
    tally(rule, llm);
    done += 1;
    onScore(j.id, rule, llm);
    onProgress({ done, total, retireCount, reviewCount, keepCount });
    if (done === total) onComplete();
  }

  async function worker() {
    while (queue.length && !stopped) {
      const j = queue.shift();
      try { await processOne(j); } catch (_) { /* swallow */ }
    }
  }

  return {
    enqueue(journeys) {
      total = journeys.length; done = 0; retireCount = 0; reviewCount = 0; keepCount = 0; stopped = false;
      queue.length = 0; queue.push(...journeys);
      const n = Math.min(concurrency, journeys.length);
      for (let i = 0; i < n; i += 1) worker();
    },
    stop() { stopped = true; queue.length = 0; },
  };
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function escAI(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
