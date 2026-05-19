/**
 * graph/edges.js — LangGraph conditional edge functions
 *
 * Each function receives the current graph state and returns the name of the
 * next node to route to. These are used with addConditionalEdges() in
 * journey-graph.js.
 *
 * Edge functions:
 *   routeAudienceResolution  — after enrich_journey: resolve or skip audiences?
 *   routeAfterParse          — after parse_result: success, retry, or give up?
 */

'use strict';

const { log } = require('../lib/logger');

/** Maximum number of LLM scoring retry attempts before giving up. */
const MAX_RETRIES = 2;

// ── Edge 1: after enrich_journey ──────────────────────────────────────────────
/**
 * Routes to 'resolve_audiences' if the journey has audience refs AND the
 * request includes an Adobe token. Otherwise routes to 'skip_audiences'.
 *
 * Decision criteria:
 *   - rawAudiences.length > 0  → at least one audience was found in the journey
 *   - cfg.token present        → Adobe UPS API credentials are available
 *
 * @param {object} state
 * @returns {'resolve_audiences' | 'skip_audiences'}
 */
function routeAudienceResolution(state) {
  const hasAudiences = Array.isArray(state.rawAudiences) && state.rawAudiences.length > 0;
  const hasToken     = !!(state.cfg && state.cfg.token);

  const route = (hasAudiences && hasToken) ? 'resolve_audiences' : 'skip_audiences';

  log('debug', '🔀 Edge: route_audience_resolution', {
    has_audiences: hasAudiences,
    has_token:     hasToken,
    audience_count: state.rawAudiences?.length || 0,
    route,
  });

  return route;
}

// ── Edge 2: after parse_result ────────────────────────────────────────────────
/**
 * Routes based on whether JSON parsing succeeded and how many retries remain.
 *
 * Success path:   state.parsed is non-null       → '__end__'
 * Retry path:     parsed is null + retryCount < MAX_RETRIES  → 'score_journey'
 * Give-up path:   parsed is null + retryCount >= MAX_RETRIES → '__end__'
 *
 * The retry path loops back to score_journey, which will call scoring-agent
 * with retryCount > 0 to append a stricter JSON-only instruction to the prompt.
 *
 * @param {object} state
 * @returns {'score_journey' | '__end__'}
 */
function routeAfterParse(state) {
  if (state.parsed) {
    log('debug', '🔀 Edge: route_after_parse → __end__ (success)', {
      id:    state.enrichedJourney?.id,
      score: state.parsed.retirementScore,
    });
    return '__end__';
  }

  if ((state.retryCount || 0) < MAX_RETRIES) {
    log('warn', '🔀 Edge: route_after_parse → score_journey (retry)', {
      id:          state.enrichedJourney?.id,
      retry_count: state.retryCount,
      max_retries: MAX_RETRIES,
    });
    return 'score_journey';
  }

  log('error', '🔀 Edge: route_after_parse → __end__ (max retries exhausted)', {
    id:          state.enrichedJourney?.id,
    retry_count: state.retryCount,
    max_retries: MAX_RETRIES,
  });
  return '__end__';
}

module.exports = {
  routeAudienceResolution,
  routeAfterParse,
  MAX_RETRIES,
};
