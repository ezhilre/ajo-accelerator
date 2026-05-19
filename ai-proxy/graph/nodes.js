/**
 * graph/nodes.js — LangGraph node functions
 *
 * Each node receives the current graph state, performs one unit of work,
 * and returns a partial state update (only the fields it modifies).
 *
 * Nodes wrap existing agent/lib code — no business logic lives here.
 *
 * Node execution order (see journey-graph.js for the compiled graph):
 *   1. enrichJourneyNode       — enrich journey + extract audience refs
 *   2a. resolveAudiencesNode   — Agent 1: fetch UPS + LLM plain-English
 *   2b. skipAudiencesNode      — passthrough: no audiences or no token
 *   3. scoreJourneyNode        — Agent 2: build prompt + call Ollama
 *   4. parseResultNode         — extractJson + increment retryCount on failure
 */

'use strict';

const { resolveJourneyAudiences } = require('../agents/audience-agent');
const { scoreJourney }            = require('../agents/scoring-agent');
const { extractJson }             = require('../lib/queue');
const { log }                     = require('../lib/logger');

// ── Helpers (duplicated from server.js to keep graph self-contained) ──────────

/** Compute _daysStale and _isDefaultName on the raw journey. */
function enrichJourney(journey) {
  const modifiedAt = journey.metadata?.lastModifiedAt;
  const daysStale  = modifiedAt
    ? Math.floor((Date.now() - new Date(modifiedAt).getTime()) / 86400000) : 0;
  const DEFAULT_NAME_RE = /^Journey\s*[\-_]?\s*\d+\s*(v\d+)?$/i;
  return {
    ...journey,
    _daysStale:     daysStale,
    _isDefaultName: !!(journey.name && DEFAULT_NAME_RE.test(journey.name.trim())),
  };
}

/**
 * Extract all unique audience refs from a journey object.
 * Checks top-level audiences[], canvas node audiences[], audienceId fields, etc.
 */
function extractAllAudiences(journey) {
  const map = new Map();

  const addAudience = (a) => {
    if (a && a.id) map.set(a.id, { id: a.id, name: a.name || '' });
  };

  // 1. Top-level audiences array
  (Array.isArray(journey.audiences) ? journey.audiences : []).forEach(addAudience);

  // 2 & 3. Canvas / flat nodes
  const rawNodes = [
    ...(Array.isArray(journey.canvas?.nodes) ? journey.canvas.nodes : []),
    ...(Array.isArray(journey.nodes) ? journey.nodes : []),
    ...(journey.canvas?.nodes && typeof journey.canvas.nodes === 'object' && !Array.isArray(journey.canvas.nodes)
      ? Object.values(journey.canvas.nodes) : []),
    ...(Array.isArray(journey.actions) ? journey.actions : []),
    ...(Array.isArray(journey.events) ? journey.events : []),
    ...(Array.isArray(journey.conditions) ? journey.conditions : []),
  ];

  rawNodes.forEach((node) => {
    if (Array.isArray(node.audiences)) node.audiences.forEach(addAudience);
    if (node.audienceId) addAudience({ id: node.audienceId, name: node.audienceName || '' });
    if (node.segmentId)  addAudience({ id: node.segmentId,  name: node.segmentName  || '' });
  });

  // 4. Top-level single IDs
  if (journey.audienceId) addAudience({ id: journey.audienceId, name: '' });
  if (journey.segmentId)  addAudience({ id: journey.segmentId,  name: '' });
  if (journey.segment?.id) addAudience({ id: journey.segment.id, name: journey.segment.name || '' });

  return [...map.values()];
}

// ── Node 1: enrich_journey ─────────────────────────────────────────────────────
/**
 * Enriches the raw journey with computed fields and extracts audience refs.
 * Always runs first — deterministic, no LLM call.
 *
 * @param {object} state
 * @returns {{ enrichedJourney: object, rawAudiences: Array }}
 */
async function enrichJourneyNode(state) {
  const { journey } = state;
  log('info', '🔧 Node: enrich_journey', { id: journey?.id, name: (journey?.name || '').slice(0, 40) });

  const enriched     = enrichJourney(journey);
  const rawAudiences = extractAllAudiences(enriched);

  log('info', '🔧 Node: enrich_journey — complete', {
    id:              enriched.id,
    days_stale:      enriched._daysStale,
    is_default_name: enriched._isDefaultName,
    audience_count:  rawAudiences.length,
  });

  return { enrichedJourney: enriched, rawAudiences };
}

// ── Node 2a: resolve_audiences ────────────────────────────────────────────────
/**
 * Agent 1 — Resolves audience definitions from Adobe UPS API and enriches
 * them with LLM-generated plain-English descriptions.
 * Only runs when rawAudiences.length > 0 AND cfg.token is present.
 *
 * @param {object} state
 * @returns {{ resolvedAudiences: Array }}
 */
async function resolveAudiencesNode(state) {
  const { rawAudiences, cfg, enrichedJourney } = state;
  const sep = '━'.repeat(80);

  log('info', `\n${sep}`);
  log('info', '  AGENT 1 — AUDIENCE RESOLVER (LangGraph node: resolve_audiences)');
  log('info', sep);
  log('info', '🎭 Node: resolve_audiences — starting', {
    journey_id: enrichedJourney?.id,
    count:      rawAudiences.length,
    ids:        rawAudiences.map((a) => a.id).join(', '),
  });

  try {
    const resolved = await resolveJourneyAudiences(rawAudiences, cfg);
    const ok = resolved.filter((a) => a.apiStatus === 'resolved').length;
    log('info', '🎭 Node: resolve_audiences — complete', {
      total: resolved.length, ok, failed: resolved.length - ok,
    });
    return { resolvedAudiences: resolved };
  } catch (e) {
    log('error', '🎭 Node: resolve_audiences — failed', { error: e.message });
    return { resolvedAudiences: [], error: `audience-resolve: ${e.message}` };
  }
}

// ── Node 2b: skip_audiences ───────────────────────────────────────────────────
/**
 * Passthrough node — emits an empty resolvedAudiences array.
 * Runs when there are no audience refs in the journey or no Adobe token.
 *
 * @param {object} state
 * @returns {{ resolvedAudiences: [] }}
 */
async function skipAudiencesNode(state) {
  const reason = !state.rawAudiences?.length ? 'no audiences in journey' : 'no Adobe token';
  log('info', '🎭 Node: skip_audiences — audience resolution skipped', { reason });
  return { resolvedAudiences: [] };
}

// ── Node 3: score_journey ─────────────────────────────────────────────────────
/**
 * Agent 2 — Builds the scoring prompt and calls the Ollama LLM.
 * On retries (retryCount > 0), scoring-agent appends a strict JSON-only instruction
 * to the prompt to increase the probability of valid JSON output.
 *
 * @param {object} state
 * @returns {{ prompt, rawText, promptTokens, completionTokens }}
 */
async function scoreJourneyNode(state) {
  const { enrichedJourney, resolvedAudiences, retryCount } = state;
  const sep = '━'.repeat(80);

  log('info', `\n${sep}`);
  log('info', `  AGENT 2 — JOURNEY SCORER (LangGraph node: score_journey)${retryCount > 0 ? ` [RETRY #${retryCount}]` : ''}`);
  log('info', sep);
  log('info', '🎯 Node: score_journey — starting', {
    id:         enrichedJourney?.id,
    name:       (enrichedJourney?.name || '').slice(0, 40),
    retry:      retryCount,
    audiences:  resolvedAudiences?.length || 0,
  });

  try {
    // Pass retryCount into scoreJourney so it can append stricter JSON instructions
    const journey = { ...enrichedJourney, audiences: resolvedAudiences || [] };
    const result  = await scoreJourney(journey, resolvedAudiences || [], retryCount);

    log('info', '🎯 Node: score_journey — LLM responded', {
      id:          enrichedJourney?.id,
      raw_chars:   (result.rawText || '').length,
      prompt_tok:  result.promptTokens,
      compl_tok:   result.completionTokens,
    });

    return {
      prompt:           result.prompt,
      rawText:          result.rawText,
      promptTokens:     result.promptTokens,
      completionTokens: result.completionTokens,
    };
  } catch (e) {
    log('error', '🎯 Node: score_journey — failed', { id: enrichedJourney?.id, error: e.message });
    throw e; // Let LangGraph propagate — no retry possible without rawText
  }
}

// ── Node 4: parse_result ──────────────────────────────────────────────────────
/**
 * Attempts to extract valid JSON from the LLM's raw response text.
 * On failure, increments retryCount so the conditional edge can route
 * back to score_journey for another attempt (up to MAX_RETRIES).
 *
 * @param {object} state
 * @returns {{ parsed, retryCount, error? }}
 */
async function parseResultNode(state) {
  const { rawText, enrichedJourney, retryCount } = state;
  const id = enrichedJourney?.id || 'unknown';

  log('info', '🔍 Node: parse_result — attempting JSON parse', {
    id, attempt: retryCount + 1, raw_chars: (rawText || '').length,
  });

  const parsed = extractJson(rawText, id);

  if (parsed) {
    log('info', '🔍 Node: parse_result — JSON parsed successfully', {
      id,
      score:      parsed.retirementScore,
      verdict:    parsed.retirementLabel,
      confidence: parsed.confidence,
      attempt:    retryCount + 1,
    });
    return { parsed, error: null };
  }

  const newRetryCount = (retryCount || 0) + 1;
  log('warn', '🔍 Node: parse_result — JSON parse failed', {
    id,
    attempt:       retryCount + 1,
    new_retry_count: newRetryCount,
    raw_preview:   (rawText || '').slice(0, 120).replace(/\n/g, ' '),
  });

  return {
    parsed:     null,
    retryCount: newRetryCount,
    error:      `JSON parse failed on attempt ${retryCount + 1}`,
  };
}

module.exports = {
  enrichJourneyNode,
  resolveAudiencesNode,
  skipAudiencesNode,
  scoreJourneyNode,
  parseResultNode,
};
