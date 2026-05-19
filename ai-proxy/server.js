/**
 * AJO Journey Cleanup — AI Proxy Server
 *
 * Slim entry point: express setup + routes only.
 * All business logic lives in agents/ and lib/.
 *
 * Usage:
 *   cd ai-proxy && npm install && node server.js
 *
 * Structure:
 *   agents/audience-agent.js  — Agent 1: fetch UPS API + normalize + LLM plain-English
 *   agents/scoring-agent.js   — Agent 2: buildPrompt + callOllama + extractJson
 *   lib/logger.js             — structured logger + writeLlmFile
 *   lib/queue.js              — Ollama client + concurrency queue + token stats
 *   lib/expression-parser.js  — Adobe UPS PQL/AST normalizer (pure JS)
 *   lib/journey-analyzer.js   — canvas node extraction, flow path, intent layer
 *
 * Environment variables: see .env.example
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

// ── Modules ───────────────────────────────────────────────────────────────────
const { log, writeLlmFile, LOG_LEVEL, LOG_LEVELS }   = require('./lib/logger');
const {
  acquireSlot, releaseSlot, tokenStats, resetTokenStats,
  checkOllamaAvailability, getOllamaStatus, MODEL, LLM_CONCURRENCY,
  OLLAMA_BASE,
} = require('./lib/queue');
const { resolveJourneyAudiences, buildAudienceDefinitionsBlock } = require('./agents/audience-agent'); // eslint-disable-line no-unused-vars
const { scoreJourney }                               = require('./agents/scoring-agent');

const PORT = parseInt(process.env.PORT || '3001', 10);

// Extra CORS origins from env
const extraOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((o) => o.trim()).filter(Boolean);
const ORIGIN_RE = /^https?:\/\/(localhost(:\d+)?|[a-z0-9-]+--[a-z0-9-]+--[a-z0-9-]+\.aem\.(live|page))(\/.*)?$/i;

// ── Adobe credentials (for Adobe credentials status in /health) ───────────────
const ADOBE_TOKEN   = process.env.ADOBE_TOKEN   || '';
const ADOBE_API_KEY = process.env.ADOBE_API_KEY || '';
const ADOBE_ORG_ID  = process.env.ADOBE_ORG_ID  || '';
const ADOBE_SANDBOX = process.env.ADOBE_SANDBOX || '';
const ADOBE_UPS_BASE = process.env.ADOBE_UPS_BASE || 'https://platform.adobe.io/data/core/ups';
const LLM_LOG_DIR   = process.env.LLM_LOG_DIR || null;
const LOG_FILE      = process.env.LOG_FILE || null;

// ── Request logger middleware ─────────────────────────────────────────────────
function requestLogger(req, res, next) {
  const start    = Date.now();
  const { method, path: reqPath } = req;
  const isHealth = reqPath === '/health';

  if (!isHealth || LOG_LEVEL <= LOG_LEVELS.debug) {
    log('info', `→ ${method} ${reqPath}`, {
      ip:        req.ip || req.socket?.remoteAddress,
      body_keys: req.body ? Object.keys(req.body).join(',') : '',
    });
  }

  res.on('finish', () => {
    const ms  = Date.now() - start;
    const sc  = res.statusCode;
    const lvl = sc >= 500 ? 'error' : sc >= 400 ? 'warn' : 'info';
    if (!isHealth || LOG_LEVEL <= LOG_LEVELS.debug) {
      log(lvl, `← ${method} ${reqPath}`, { status: sc, ms: `${ms}ms` });
    }
  });

  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve per-request Adobe credentials, falling back to env vars. */
function effectiveCfg(reqCfg) {
  return {
    token:   (reqCfg && reqCfg.token)   || ADOBE_TOKEN,
    apiKey:  (reqCfg && reqCfg.apiKey)  || ADOBE_API_KEY,
    orgId:   (reqCfg && reqCfg.orgId)   || ADOBE_ORG_ID,
    sandbox: (reqCfg && reqCfg.sandbox) || ADOBE_SANDBOX,
  };
}

/** Enrich a journey with computed fields before passing to agents. */
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
 * Extract all unique audiences from a journey object.
 * Checks multiple locations where the AJO API places audience references:
 *   1. journey.audiences[]            — top-level array (some API shapes)
 *   2. canvas.nodes[].audiences[]     — node-level audiences array (audience_qualification nodes)
 *   3. nodes[].audiences[]            — flat nodes array variant
 *   4. journey.audienceId             — single top-level ID (legacy)
 *   5. events[].audienceId / segmentId — event-node IDs
 */
function extractAllAudiences(journey) {
  const map = new Map();

  const addAudience = (a) => {
    if (a && a.id) map.set(a.id, { id: a.id, name: a.name || '' });
  };

  // 1. Top-level audiences array
  (Array.isArray(journey.audiences) ? journey.audiences : []).forEach(addAudience);

  // 2 & 3. Canvas / flat nodes — scan all nodes for .audiences[] arrays
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
    // node.audiences[] — present on audience_qualification nodes
    if (Array.isArray(node.audiences)) {
      node.audiences.forEach(addAudience);
    }
    // node.audienceId / node.segmentId — some node shapes use a single ID
    if (node.audienceId) addAudience({ id: node.audienceId, name: node.audienceName || '' });
    if (node.segmentId)  addAudience({ id: node.segmentId,  name: node.segmentName  || '' });
  });

  // 4. Top-level single audienceId
  if (journey.audienceId) addAudience({ id: journey.audienceId, name: '' });
  if (journey.segmentId)  addAudience({ id: journey.segmentId,  name: '' });

  // 5. segment object
  if (journey.segment?.id) addAudience({ id: journey.segment.id, name: journey.segment.name || '' });

  return [...map.values()];
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: (origin, cb) => {
    if (!origin)                        return cb(null, true);
    if (ORIGIN_RE.test(origin))         return cb(null, true);
    if (extraOrigins.includes(origin))  return cb(null, true);
    log('warn', 'CORS blocked', { origin });
    cb(new Error(`CORS blocked: ${origin}`));
  },
  methods:        ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials:    false,
}));

app.use(express.json({ limit: '2mb' }));
app.use(requestLogger);

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const start = Date.now();
  await checkOllamaAvailability();
  const { online, lastChecked } = getOllamaStatus();
  const ms = Date.now() - start;

  if (online) {
    try {
      const r    = await fetch(`${OLLAMA_BASE}/api/tags`);
      const data = await r.json();
      const models = (data.models || []).map((m) => m.name);
      log('info', '🩺 Health check', { ollama: 'connected', model: MODEL, ms: `${ms}ms` });
      return res.json({
        status: 'ok', model: MODEL, ollama: 'connected',
        availableModels: models, lastChecked,
        adobeCredentials: !!(ADOBE_TOKEN && ADOBE_API_KEY && ADOBE_ORG_ID),
      });
    } catch (_) { /* fall through */ }
  }

  log('error', '🩺 Health check — Ollama unreachable', { ms: `${ms}ms` });
  res.status(503).json({ status: 'error', model: MODEL, ollama: 'unreachable', lastChecked });
});

// ── POST /audience/resolve ────────────────────────────────────────────────────
// Input:  { audiences: [{id, name}], cfg? }
// Output: { resolved: [{id, name, apiStatus, durationMs, normalized, plainEnglish, ...}] }
app.post('/audience/resolve', async (req, res) => {
  const { audiences, cfg } = req.body || {};
  if (!Array.isArray(audiences) || !audiences.length) {
    return res.status(400).json({ error: 'Missing audiences array' });
  }

  const eCfg = effectiveCfg(cfg);
  if (!eCfg.token || !eCfg.apiKey || !eCfg.orgId) {
    return res.status(400).json({
      error: 'Missing Adobe credentials. Provide cfg.token/apiKey/orgId in request body or set ADOBE_TOKEN/ADOBE_API_KEY/ADOBE_ORG_ID in .env',
    });
  }

  log('info', '🎭 Audience resolve request', { count: audiences.length });
  const start = Date.now();
  try {
    const resolved = await resolveJourneyAudiences(audiences, eCfg);
    const ms = Date.now() - start;
    const ok = resolved.filter((a) => a.apiStatus === 'resolved').length;
    log('info', '🎭 Audience resolve complete', { total: resolved.length, ok, ms: `${ms}ms` });
    res.json({ resolved });
  } catch (e) {
    log('error', '🎭 Audience resolve failed', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── POST /score ───────────────────────────────────────────────────────────────
// Input:  { journey: {...}, cfg? }
// Output: { journeyId, retirementScore, retirementLabel, ..., _audiences }
app.post('/score', async (req, res) => {
  const { online, lastChecked } = getOllamaStatus();
  if (!online) {
    return res.status(503).json({
      error: 'AI backend (Ollama) is currently offline. Please start Ollama and try again.',
      ollama: 'unreachable', lastChecked,
    });
  }

  const rawJourney = req.body?.journey;
  if (!rawJourney || !rawJourney.id) {
    return res.status(400).json({ error: 'Missing journey object with id' });
  }

  const journey = enrichJourney(rawJourney);
  const eCfg    = effectiveCfg(req.body?.cfg);
  const { id }  = journey;
  const scoreStart = Date.now();

  log('info', '🎯 Score request', {
    id, name: (journey.name || '').slice(0, 40), status: journey.status, days_stale: journey._daysStale,
  });

  await acquireSlot(id);
  try {
    // Agent 1 — Audience Resolver
    const rawAudiences = extractAllAudiences(journey);
    let audienceResults = [];
    const sep = '━'.repeat(80);
    log('info', `\n${sep}`);
    log('info', `  AGENT 1 — AUDIENCE RESOLVER`);
    log('info', sep);
    if (rawAudiences.length && eCfg.token) {
      log('info', '🎭 Agent 1 — resolving audiences', { journey_id: id, count: rawAudiences.length, ids: rawAudiences.map((a) => a.id).join(', ') });
      audienceResults = await resolveJourneyAudiences(rawAudiences, eCfg);
    } else if (!rawAudiences.length) {
      log('info', '🎭 Agent 1 — No audiences found in this journey (or audience resolution skipped).');
    } else {
      log('info', '🎭 Agent 1 — Audience resolution skipped (no Adobe token provided).');
    }

    // Agent 2 — Journey Scorer
    const { parsed, rawText, promptTokens, completionTokens, prompt } =
      await scoreJourney({ ...journey, audiences: audienceResults }, audienceResults);

    const totalMs = Date.now() - scoreStart;
    writeLlmFile(journey, prompt, rawText, parsed, totalMs, audienceResults);

    if (!parsed) {
      return res.status(422).json({
        error: 'LLM returned non-JSON response', raw: rawText.slice(0, 500), fallback: true,
      });
    }

    log('info', '🎯 Score complete', {
      id, ms: `${totalMs}ms`, verdict: parsed.retirementLabel, score: parsed.retirementScore,
      audiences_resolved: audienceResults.length,
    });

    res.json({
      journeyId: id,
      ...parsed,
      model: MODEL,
      _raw:     rawText.slice(0, 200),
      _tokens:  { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens },
      _audiences: audienceResults.map((a) => ({
        id: a.id, name: a.name, plainEnglish: a.plainEnglish, status: a.apiStatus,
      })),
    });
  } catch (e) {
    const totalMs  = Date.now() - scoreStart;
    const timedOut = e.name === 'AbortError';
    log('error', `🎯 Score ${timedOut ? 'timed out' : 'errored'}`, { id, ms: `${totalMs}ms`, error: e.message });
    res.status(timedOut ? 504 : 500).json({ error: timedOut ? 'LLM request timed out' : e.message, journeyId: id });
  } finally {
    releaseSlot(id);
  }
});

// ── POST /score/batch ─────────────────────────────────────────────────────────
// Input:  { journeys: [...], cfg? }
// Output: { results: [...] }
app.post('/score/batch', async (req, res) => {
  const { online, lastChecked } = getOllamaStatus();
  if (!online) {
    return res.status(503).json({
      error: 'AI backend (Ollama) is currently offline.',
      ollama: 'unreachable', lastChecked,
    });
  }

  const journeys = req.body?.journeys;
  if (!Array.isArray(journeys) || !journeys.length) {
    return res.status(400).json({ error: 'Missing journeys array' });
  }

  const eCfg       = effectiveCfg(req.body?.cfg);
  const batch      = journeys.slice(0, 10);
  const batchStart = Date.now();
  log('info', '📦 Batch scoring started', { count: batch.length, ids: batch.map((j) => j.id).join(',') });

  const results = [];
  for (let i = 0; i < batch.length; i += 1) {
    const journey  = enrichJourney(batch[i]);
    const { id }   = journey;
    const itemStart = Date.now();

    log('info', `📦 Batch [${i + 1}/${batch.length}]`, { id, name: (journey.name || '').slice(0, 35) });

    await acquireSlot(id); // eslint-disable-line no-await-in-loop
    try {
      // Agent 1
      const rawAudiences = extractAllAudiences(journey);
      let audienceResults = [];
      if (rawAudiences.length && eCfg.token) {
        // eslint-disable-next-line no-await-in-loop
        audienceResults = await resolveJourneyAudiences(rawAudiences, eCfg);
      }

      // Agent 2
      // eslint-disable-next-line no-await-in-loop
      const { parsed, rawText, promptTokens, completionTokens, prompt } =
        await scoreJourney({ ...journey, audiences: audienceResults }, audienceResults);

      const itemMs = Date.now() - itemStart;
      writeLlmFile(journey, prompt, rawText, parsed, itemMs, audienceResults);

      results.push({
        journeyId: id,
        ...(parsed || { error: 'parse-failed', raw: rawText.slice(0, 200) }),
        model:      MODEL,
        _tokens:    { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens },
        _audiences: audienceResults.map((a) => ({
          id: a.id, name: a.name, plainEnglish: a.plainEnglish, status: a.apiStatus,
        })),
      });

      log('info', `📦 Batch [${i + 1}/${batch.length}] done`, {
        id, ms: `${itemMs}ms`, score: parsed?.retirementScore,
      });
    } catch (e) {
      const itemMs = Date.now() - itemStart;
      log('error', `📦 Batch [${i + 1}/${batch.length}] error`, { id, ms: `${itemMs}ms`, error: e.message });
      results.push({ journeyId: id, error: e.message });
    } finally {
      releaseSlot(id);
    }
  }

  const totalMs = Date.now() - batchStart;
  const ok      = results.filter((r) => !r.error).length;
  log('info', '📦 Batch complete', {
    total: batch.length, ok, failed: results.length - ok,
    ms: `${totalMs}ms`, avg_ms: `${Math.round(totalMs / batch.length)}ms`,
  });

  res.json({ results });
});

// ── GET /stats ────────────────────────────────────────────────────────────────
app.get('/stats', (_req, res) => {
  const uptime = Math.round((Date.now() - new Date(tokenStats.startedAt).getTime()) / 1000);
  const stats  = {
    ...tokenStats,
    totalTokens:   tokenStats.totalPromptTokens + tokenStats.totalCompletionTokens,
    uptimeSeconds: uptime,
    model:         MODEL,
  };
  log('info', '📊 Stats requested', {
    requests:          stats.totalRequests,
    prompt_tokens:     stats.totalPromptTokens,
    completion_tokens: stats.totalCompletionTokens,
    total_tokens:      stats.totalTokens,
  });
  res.json(stats);
});

// ── POST /stats/reset ─────────────────────────────────────────────────────────
app.post('/stats/reset', (_req, res) => {
  resetTokenStats();
  log('info', '📊 Stats reset');
  res.json({ ok: true, message: 'Token stats reset' });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  log('warn', '404 Not Found', { method: req.method, path: req.path });
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  log('error', 'Unhandled server error', { method: req.method, path: req.path, error: err.message });
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('\x1b[1m\x1b[35m🤖  AJO AI Proxy  started\x1b[0m');
  console.log('-'.repeat(48));
  log('info', 'Server listening',  { port: PORT, url: `http://localhost:${PORT}` });
  log('info', 'Ollama backend',    { url: OLLAMA_BASE, model: MODEL });
  log('info', 'Queue settings',    { concurrency: LLM_CONCURRENCY, timeout_ms: 60000 });
  log('info', 'Adobe credentials', {
    token:    ADOBE_TOKEN    ? '✓ set' : '✗ missing',
    api_key:  ADOBE_API_KEY  ? '✓ set' : '✗ missing',
    org_id:   ADOBE_ORG_ID   ? '✓ set' : '✗ missing',
    sandbox:  ADOBE_SANDBOX  || '(default)',
    ups_base: ADOBE_UPS_BASE,
  });
  if (LOG_FILE)    log('info', 'Log file',    { path: path.resolve(LOG_FILE) });
  if (LLM_LOG_DIR) log('info', 'LLM log dir', { path: path.resolve(LLM_LOG_DIR) });
  console.log('');
  console.log('\x1b[2mEndpoints:\x1b[0m');
  console.log(`  \x1b[36mGET  \x1b[0mhttp://localhost:${PORT}/health`);
  console.log(`  \x1b[36mPOST \x1b[0mhttp://localhost:${PORT}/audience/resolve  { audiences: [{id,name}], cfg? }`);
  console.log(`  \x1b[36mPOST \x1b[0mhttp://localhost:${PORT}/score             { journey: {...}, cfg? }`);
  console.log(`  \x1b[36mPOST \x1b[0mhttp://localhost:${PORT}/score/batch       { journeys: [...], cfg? }`);
  console.log(`  \x1b[36mGET  \x1b[0mhttp://localhost:${PORT}/stats`);
  console.log(`  \x1b[36mPOST \x1b[0mhttp://localhost:${PORT}/stats/reset`);
  console.log('');
  console.log('\x1b[2mModules:\x1b[0m');
  console.log('  agents/audience-agent.js  — Agent 1: UPS fetch + expression parser + LLM');
  console.log('  agents/scoring-agent.js   — Agent 2: prompt builder + LLM scorer');
  console.log('  lib/logger.js             — structured logger + LLM log writer');
  console.log('  lib/queue.js              — Ollama client + concurrency queue');
  console.log('  lib/expression-parser.js  — Adobe UPS PQL/AST normalizer');
  console.log('  lib/journey-analyzer.js   — canvas node extraction + flow path + intent');
  console.log('');
});
