/**
 * graph/journey-graph.js — Compiled LangGraph StateGraph for journey scoring
 *
 * This module assembles the complete agent pipeline as a LangGraph StateGraph
 * and exports a compiled graph instance ready for graph.invoke(initialState).
 *
 * Graph topology:
 *
 *   [__start__]
 *       ↓
 *   [enrich_journey]          — compute _daysStale, _isDefaultName, extract audiences
 *       ↓ (conditional)
 *   ┌─────────────────────────────────────────────────┐
 *   │  has audiences + token?                          │
 *   │   YES → [resolve_audiences]  (Agent 1)           │
 *   │   NO  → [skip_audiences]                         │
 *   └─────────────────────────────────────────────────┘
 *       ↓ (both paths merge here)
 *   [score_journey]           — Agent 2: build prompt + call Ollama
 *       ↓
 *   [parse_result]            — extractJson; increment retryCount on failure
 *       ↓ (conditional)
 *   ┌─────────────────────────────────────────────────┐
 *   │  parsed OK?                                      │
 *   │   YES                    → [__end__] (success)   │
 *   │   NO + retryCount < 2    → [score_journey] loop  │
 *   │   NO + retryCount >= 2   → [__end__] (failed)    │
 *   └─────────────────────────────────────────────────┘
 *
 * Usage:
 *   const { journeyGraph } = require('./graph/journey-graph');
 *   const finalState = await journeyGraph.invoke({ journey, cfg });
 */

'use strict';

const { StateGraph, END, START } = require('@langchain/langgraph');

const { GraphStateChannels }   = require('./state');
const {
  enrichJourneyNode,
  resolveAudiencesNode,
  skipAudiencesNode,
  scoreJourneyNode,
  parseResultNode,
} = require('./nodes');
const { routeAudienceResolution, routeAfterParse } = require('./edges');
const { log } = require('../lib/logger');

// ── Build and compile the StateGraph ─────────────────────────────────────────

log('info', '🕸️  Building LangGraph journey-scoring StateGraph…');

const workflow = new StateGraph({ channels: GraphStateChannels })

  // ── Nodes ──────────────────────────────────────────────────────────────────
  .addNode('enrich_journey',    enrichJourneyNode)
  .addNode('resolve_audiences', resolveAudiencesNode)
  .addNode('skip_audiences',    skipAudiencesNode)
  .addNode('score_journey',     scoreJourneyNode)
  .addNode('parse_result',      parseResultNode)

  // ── Entry point ────────────────────────────────────────────────────────────
  .addEdge(START, 'enrich_journey')

  // ── After enrich_journey: branch on audience availability + token ──────────
  .addConditionalEdges(
    'enrich_journey',
    routeAudienceResolution,
    {
      resolve_audiences: 'resolve_audiences',
      skip_audiences:    'skip_audiences',
    },
  )

  // ── Both audience paths converge into score_journey ───────────────────────
  .addEdge('resolve_audiences', 'score_journey')
  .addEdge('skip_audiences',    'score_journey')

  // ── After scoring: parse the raw LLM output ───────────────────────────────
  .addEdge('score_journey', 'parse_result')

  // ── After parse: success → end, failure → retry loop or end ──────────────
  .addConditionalEdges(
    'parse_result',
    routeAfterParse,
    {
      score_journey: 'score_journey',  // retry path (loops back)
      __end__:       END,              // success or max-retries-exhausted
    },
  );

/** Compiled, executable LangGraph instance. */
const journeyGraph = workflow.compile();

log('info', '🕸️  LangGraph journey-scoring graph compiled successfully', {
  nodes: ['enrich_journey', 'resolve_audiences', 'skip_audiences', 'score_journey', 'parse_result'],
  conditional_edges: ['enrich_journey → audience branch', 'parse_result → retry/end'],
});

module.exports = { journeyGraph };
