/**
 * graph/state.js — LangGraph state channel definitions
 *
 * Defines the shared state object that flows through all nodes in the
 * journey scoring graph. Each channel specifies a default value and
 * an optional reducer (how to merge updates from parallel nodes).
 *
 * LangGraph JS uses a plain object with `value` (default) and optional
 * `reducer` per channel.
 */

'use strict';

/**
 * GraphStateChannels — channel definitions for StateGraph
 *
 * Channels with no reducer use last-write-wins (default LangGraph behaviour).
 * The `retryCount` channel uses a reducer that keeps the max value seen,
 * preventing accidental resets on partial updates.
 */
const GraphStateChannels = {
  // ── Input fields ────────────────────────────────────────────────────────────
  /** Raw journey object as received from the HTTP request body */
  journey: {
    value: (prev, next) => (next !== undefined ? next : prev),
    default: () => null,
  },
  /** Adobe credentials { token, apiKey, orgId, sandbox } */
  cfg: {
    value: (prev, next) => (next !== undefined ? next : prev),
    default: () => null,
  },

  // ── After enrich_journey node ────────────────────────────────────────────
  /** Journey enriched with _daysStale and _isDefaultName computed fields */
  enrichedJourney: {
    value: (prev, next) => (next !== undefined ? next : prev),
    default: () => null,
  },
  /** Audience refs extracted from the journey: [{id, name}] */
  rawAudiences: {
    value: (prev, next) => (next !== undefined ? next : prev),
    default: () => [],
  },

  // ── After resolve_audiences / skip_audiences node ───────────────────────
  /** Agent 1 output: resolved audience objects with plainEnglish descriptions */
  resolvedAudiences: {
    value: (prev, next) => (next !== undefined ? next : prev),
    default: () => [],
  },

  // ── After score_journey node ─────────────────────────────────────────────
  /** The complete prompt string sent to the LLM */
  prompt: {
    value: (prev, next) => (next !== undefined ? next : prev),
    default: () => null,
  },
  /** Raw LLM response text */
  rawText: {
    value: (prev, next) => (next !== undefined ? next : prev),
    default: () => null,
  },
  /** Ollama prompt token count */
  promptTokens: {
    value: (prev, next) => (next !== undefined ? next : prev),
    default: () => 0,
  },
  /** Ollama completion token count */
  completionTokens: {
    value: (prev, next) => (next !== undefined ? next : prev),
    default: () => 0,
  },
  /** Number of scoring retry attempts made so far (incremented on parse failure) */
  retryCount: {
    value: (prev, next) => (next !== undefined ? Math.max(prev || 0, next) : prev || 0),
    default: () => 0,
  },

  // ── After parse_result node ──────────────────────────────────────────────
  /** Parsed JSON result object from Agent 2, or null if parsing failed */
  parsed: {
    value: (prev, next) => (next !== undefined ? next : prev),
    default: () => null,
  },
  /** Error message string if a node failed; null on success */
  error: {
    value: (prev, next) => (next !== undefined ? next : prev),
    default: () => null,
  },
};

module.exports = { GraphStateChannels };
