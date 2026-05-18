/**
 * AJO Journey Cleanup — AI Proxy Server
 *
 * Phase 1: bridges browser → Ollama (local)
 * Phase 2: swap OLLAMA_BASE_URL + MODEL to point at Claude / OpenAI / Adobe AI
 *
 * Usage:
 *   cd ai-proxy && npm install && node server.js
 *
 * Environment variables:
 *   PORT=3001                               (default: 3001)
 *   OLLAMA_BASE=http://localhost:11434      (default)
 *   MODEL=llama3                            (default; try mistral, phi3, gemma2)
 *   CONCURRENCY=1                           (Ollama is single-threaded; keep at 1)
 *   LOG_FILE=./proxy.log                    (optional: also write logs to file as JSON-lines)
 *   LOG_LEVEL=info                          (debug|info|warn|error — default: info)
 *   LLM_LOG_DIR=./llm-logs                 (optional: write one .log file per journey here)
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3001', 10);
const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://localhost:11434';
const MODEL = process.env.MODEL || 'gpt-oss:20b';
const LLM_CONCURRENCY = parseInt(process.env.CONCURRENCY || '1', 10);
const REQUEST_TIMEOUT_MS = 60_000;
const LOG_FILE = process.env.LOG_FILE || null;
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;
const LLM_LOG_DIR = process.env.LLM_LOG_DIR ? path.resolve(process.env.LLM_LOG_DIR) : null;

// ── LLM per-journey file logger ───────────────────────────────────────────────

function sanitizeName(name) {
  return (name || 'unnamed')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/__+/g, '_')
    .slice(0, 60);
}

function writeLlmFile(journey, prompt, raw, parsed, durationMs) {
  if (!LLM_LOG_DIR) return;
  try {
    // Ensure directory exists
    if (!fs.existsSync(LLM_LOG_DIR)) fs.mkdirSync(LLM_LOG_DIR, { recursive: true });

    const id = journey.id || 'unknown';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = sanitizeName(journey.name);
    const fileName = `${id}_${safeName}_${ts}.log`;
    const filePath = path.join(LLM_LOG_DIR, fileName);

    const SEP = '='.repeat(80);
    const DIV = '-'.repeat(80);

    const lines = [
      SEP,
      `Journey ID   : ${id}`,
      `Journey Name : ${journey.name || '(unnamed)'}`,
      `Status       : ${journey.status || 'unknown'}`,
      `Days Stale   : ${journey._daysStale || 0}`,
      `Model        : ${MODEL}`,
      `Scored At    : ${new Date().toISOString()}`,
      `Duration     : ${durationMs}ms`,
      SEP,
      'PROMPT:',
      DIV,
      prompt,
      SEP,
      'RAW RESPONSE:',
      DIV,
      raw || '(empty)',
      SEP,
      'PARSED RESULT:',
      DIV,
    ];

    if (parsed) {
      const fields = [
        ['retirementScore', parsed.retirementScore],
        ['retirementLabel', parsed.retirementLabel],
        ['confidence',      parsed.confidence],
        ['businessValue',   parsed.businessValue],
        ['hasBusinessPurpose', parsed.hasBusinessPurpose],
        ['journeyType',    parsed.journeyType],
        ['useCaseSummary', parsed.useCaseSummary],
        ['targetAudience', parsed.targetAudience],
        ['businessPurpose', parsed.businessPurpose],
        ['reasoning',      parsed.reasoning],
        ['recommendation', parsed.recommendation],
      ];
      fields.forEach(([k, v]) => {
        if (v !== undefined && v !== null) {
          lines.push(`  ${k.padEnd(20)}: ${v}`);
        }
      });
    } else {
      lines.push('  (parse failed — see RAW RESPONSE above)');
    }

    lines.push(SEP);
    lines.push('');

    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    log('debug', '📄 LLM log written', { id, file: fileName });
  } catch (e) {
    log('warn', '📄 LLM log write failed', { id: journey.id, error: e.message });
  }
}

// ── Logger ────────────────────────────────────────────────────────────────────

let logFileStream = null;
if (LOG_FILE) {
  try {
    logFileStream = fs.createWriteStream(path.resolve(LOG_FILE), { flags: 'a' });
    // eslint-disable-next-line no-console
    console.log(`📂 Log file: ${path.resolve(LOG_FILE)}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`⚠ Could not open log file ${LOG_FILE}: ${e.message}`);
  }
}

const LEVEL_ICONS = { debug: '🔍', info: '✅', warn: '⚠ ', error: '❌' };
const LEVEL_COLORS = {
  debug: '\x1b[36m',  // cyan
  info:  '\x1b[32m',  // green
  warn:  '\x1b[33m',  // yellow
  error: '\x1b[31m',  // red
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

function log(level, message, meta = {}) {
  if ((LOG_LEVELS[level] ?? 0) < LOG_LEVEL) return;
  const ts = new Date().toISOString();
  const icon = LEVEL_ICONS[level] || '•';
  const color = LEVEL_COLORS[level] || '';

  // Build metadata string for console (compact key=value)
  const metaStr = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${DIM}${k}=${RESET}${color}${v}${RESET}`)
    .join('  ');

  const line = `${DIM}${ts}${RESET}  ${color}${icon} ${BOLD}[${level.toUpperCase()}]${RESET}${color}  ${message}${RESET}${metaStr ? '  ' + metaStr : ''}`;
  if (level === 'error' || level === 'warn') {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }

  // JSON-lines to file
  if (logFileStream) {
    logFileStream.write(JSON.stringify({ ts, level, message, ...meta }) + '\n');
  }
}

// ── Request logger middleware ─────────────────────────────────────────────────

function requestLogger(req, res, next) {
  const start = Date.now();
  const { method, path: reqPath } = req;

  // Skip noisy health-check logging unless debug level
  const isHealth = reqPath === '/health';
  if (!isHealth || LOG_LEVEL <= LOG_LEVELS.debug) {
    log('info', `→ ${method} ${reqPath}`, {
      ip: req.ip || req.socket?.remoteAddress,
      body_keys: req.body ? Object.keys(req.body).join(',') : '',
    });
  }

  res.on('finish', () => {
    const ms = Date.now() - start;
    const sc = res.statusCode;
    const lvl = sc >= 500 ? 'error' : sc >= 400 ? 'warn' : 'info';
    if (!isHealth || LOG_LEVEL <= LOG_LEVELS.debug) {
      log(lvl, `← ${method} ${reqPath}`, { status: sc, ms: `${ms}ms` });
    }
  });

  next();
}

const app = express();

// ── CORS ─────────────────────────────────────────────────────────────────────
const extraOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((o) => o.trim()).filter(Boolean);

const ORIGIN_RE = /^https?:\/\/(localhost(:\d+)?|[a-z0-9-]+--[a-z0-9-]+--[a-z0-9-]+\.aem\.(live|page))(\/.*)?$/i;

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ORIGIN_RE.test(origin)) return cb(null, true);
    if (extraOrigins.includes(origin)) return cb(null, true);
    log('warn', 'CORS blocked', { origin });
    cb(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false,
}));

app.use(express.json({ limit: '2mb' }));
app.use(requestLogger);

// ── Token usage counters (session-level, reset on server restart) ─────────────
const tokenStats = {
  totalRequests: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  startedAt: new Date().toISOString(),
};

// ── Queue ─────────────────────────────────────────────────────────────────────
let activeCount = 0;
const waitQueue = [];

function acquireSlot(journeyId) {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (activeCount < LLM_CONCURRENCY) {
        activeCount += 1;
        log('debug', 'Queue slot acquired', { journeyId, active: activeCount, queued: waitQueue.length });
        resolve();
      } else {
        if (waitQueue.length === 0) {
          log('warn', 'Queue full — request waiting', {
            journeyId,
            active: activeCount,
            waiting: waitQueue.length + 1,
            concurrency: LLM_CONCURRENCY,
          });
        }
        waitQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

function releaseSlot(journeyId) {
  activeCount -= 1;
  log('debug', 'Queue slot released', { journeyId, active: activeCount, queued: waitQueue.length });
  if (waitQueue.length) {
    const next = waitQueue.shift();
    next();
  }
}

// ── Ollama call ───────────────────────────────────────────────────────────────
async function callOllama(prompt, journeyId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const ollamaStart = Date.now();

  log('debug', '🦙 Ollama → sending prompt', {
    journeyId,
    model: MODEL,
    prompt_chars: prompt.length,
  });

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt, stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status}: ${txt}`);
    }
    const data = await res.json();
    const ms = Date.now() - ollamaStart;
    log('info', '🦙 Ollama ← response received', {
      journeyId,
      ms: `${ms}ms`,
      response_chars: (data.response || '').length,
      eval_count: data.eval_count,
    });
    const responseText = data.response || '';
    // Accumulate token usage
    const promptTokens = data.prompt_eval_count || 0;
    const completionTokens = data.eval_count || 0;
    tokenStats.totalRequests += 1;
    tokenStats.totalPromptTokens += promptTokens;
    tokenStats.totalCompletionTokens += completionTokens;
    log('info', '🦙 Ollama tokens', {
      journeyId,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      session_total: tokenStats.totalPromptTokens + tokenStats.totalCompletionTokens,
    });
    // Log full raw LLM response at debug level
    log('debug', '🦙 Ollama raw response', {
      journeyId,
      raw_response: responseText,
    });
    return { text: responseText, promptTokens, completionTokens };
  } catch (e) {
    const ms = Date.now() - ollamaStart;
    if (e.name === 'AbortError') {
      log('error', '🦙 Ollama timeout', { journeyId, after: `${REQUEST_TIMEOUT_MS}ms` });
    } else {
      log('error', '🦙 Ollama error', { journeyId, ms: `${ms}ms`, error: e.message });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── JSON extractor ────────────────────────────────────────────────────────────
function extractJson(raw, journeyId) {
  try { return JSON.parse(raw.trim()); } catch (_) { /* fall through */ }

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      const parsed = JSON.parse(fence[1].trim());
      log('debug', 'JSON extracted from markdown fence', { journeyId });
      return parsed;
    } catch (_) { /* fall through */ }
  }

  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) {
    try {
      const parsed = JSON.parse(brace[0]);
      log('debug', 'JSON extracted from brace match', { journeyId });
      return parsed;
    } catch (_) { /* fall through */ }
  }

  log('warn', 'JSON parse failed — LLM returned non-JSON', {
    journeyId,
    raw_preview: raw.slice(0, 120).replace(/\n/g, ' '),
  });
  return null;
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(journey) {
  const meta = journey.metadata || {};
  const name = journey.name || '(unnamed)';
  const status = journey.status || 'unknown';
  const version = journey.version || '1';
  const daysStale = journey._daysStale || 0;
  const createdBy = meta.createdBy || 'unknown';
  const createdAt = meta.createdAt ? meta.createdAt.slice(0, 10) : 'unknown';
  const modifiedBy = meta.lastModifiedBy || 'unknown';
  const modifiedAt = meta.lastModifiedAt ? meta.lastModifiedAt.slice(0, 10) : 'unknown';
  const isDefaultName = journey._isDefaultName ? 'YES — user never renamed it (strong abandonment signal)' : 'No';

  const actions = journey.actions || [];
  const events = journey.events || [];
  const conditions = journey.conditions || [];
  const tags = journey.tags || [];
  const description = journey.description || '';
  const audienceId = journey.audienceId || '';
  const nodeCount = actions.length + events.length + conditions.length;
  const emailCount = actions.filter((a) => (a.type || '').toLowerCase().includes('email')).length;
  const smsCount = actions.filter((a) => (a.type || '').toLowerCase().includes('sms')).length;
  const waitCount = actions.filter((a) => (a.type || '').toLowerCase().includes('wait')).length;

  return `You are an Adobe Journey Optimizer governance expert reviewing journeys for retirement.

JOURNEY METADATA:
- Name: "${name}"
- Status: ${status} | Version: ${version} | Days stale: ${daysStale}
- Created by: ${createdBy} on ${createdAt}
- Last modified by: ${modifiedBy} on ${modifiedAt}
- Name is AJO default (never renamed by user): ${isDefaultName}

JOURNEY STRUCTURE:
- Total nodes: ${nodeCount}
- Actions: ${actions.length} total (emails: ${emailCount}, SMS: ${smsCount}, waits: ${waitCount})
- Entry events/triggers: ${events.length}
- Conditions/branches: ${conditions.length}
- Has audience/segment: ${audienceId ? 'YES (' + audienceId + ')' : 'No'}
- Has description: ${description ? 'YES: "' + description.slice(0, 120) + '"' : 'No'}
- Tags: ${tags.length ? tags.join(', ') : 'none'}

SCORING CONTEXT:
- Score 80-100 = strong candidate for retirement/archiving
- Score 50-79  = uncertain, needs human review
- Score 0-49   = likely active, keep for now
- A journey with AJO default name + draft + 90+ days stale is almost certainly safe to retire
- A journey with real audience, multiple actions, and a descriptive name may be paused for a reason

TASK: Determine if this journey serves a real business purpose or is safe to retire.

Return ONLY valid JSON (no markdown fences, no explanation outside the JSON object):
{
  "journeyType": "Welcome|Promotional|Transactional|Re-engagement|Abandoned Cart|Onboarding|Retention|Test/POC|Unknown",
  "useCaseSummary": "one sentence describing what this journey was designed to do, or 'Unable to determine use case'",
  "targetAudience": "brief description of who this journey targets, or 'Unknown'",
  "businessValue": "low|medium|high",
  "hasBusinessPurpose": true or false,
  "businessPurpose": "one sentence or 'No identifiable business purpose'",
  "retirementScore": 0-100,
  "retirementLabel": "Safe to Retire|Review First|Keep Active",
  "confidence": 0-100,
  "reasoning": "2-3 sentences explaining your verdict",
  "recommendation": "Archive|Review with owner|Keep|Contact owner before deleting"
}`;
}

// ── /health ───────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const start = Date.now();
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`);
    const data = await r.json();
    const models = (data.models || []).map((m) => m.name);
    const ms = Date.now() - start;
    log('info', '🩺 Health check', {
      ollama: 'connected',
      model: MODEL,
      available_models: models.join(',') || '(none)',
      ms: `${ms}ms`,
    });
    res.json({ status: 'ok', model: MODEL, ollama: 'connected', availableModels: models });
  } catch (e) {
    const ms = Date.now() - start;
    log('error', '🩺 Health check failed — Ollama unreachable', { error: e.message, ms: `${ms}ms` });
    res.status(503).json({ status: 'error', model: MODEL, ollama: 'unreachable', error: e.message });
  }
});

// ── /score  (single journey) ──────────────────────────────────────────────────
app.post('/score', async (req, res) => {
  const journey = req.body?.journey;
  if (!journey || !journey.id) {
    log('warn', '/score — missing journey payload');
    return res.status(400).json({ error: 'Missing journey object with id' });
  }

  const { id, name, status } = journey;
  const daysStale = journey._daysStale || 0;

  log('info', '🎯 Scoring journey', { id, name: (name || '').slice(0, 40), status, days_stale: daysStale });

  const scoreStart = Date.now();
  await acquireSlot(id);
  try {
    const prompt = buildPrompt(journey);
    const { text: rawText, promptTokens, completionTokens } = await callOllama(prompt, id);
    const parsed = extractJson(rawText, id);

    const totalMs = Date.now() - scoreStart;

    // Write per-journey LLM log file
    writeLlmFile(journey, prompt, rawText, parsed, totalMs);

    if (!parsed) {
      log('error', '🎯 Score failed — non-JSON LLM response', { id, ms: `${totalMs}ms` });
      return res.status(422).json({
        error: 'LLM returned non-JSON response',
        raw: rawText.slice(0, 500),
        fallback: true,
      });
    }

    log('info', '🎯 Score complete', {
      id,
      ms: `${totalMs}ms`,
      verdict: parsed.retirementLabel,
      score: parsed.retirementScore,
      confidence: parsed.confidence,
      biz_value: parsed.businessValue,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    });
    // Log full parsed LLM result at debug level
    log('debug', '🎯 Parsed LLM result', {
      id,
      businessValue: parsed.businessValue,
      hasBusinessPurpose: parsed.hasBusinessPurpose,
      businessPurpose: parsed.businessPurpose,
      retirementScore: parsed.retirementScore,
      retirementLabel: parsed.retirementLabel,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      recommendation: parsed.recommendation,
    });

    res.json({
      journeyId: id,
      ...parsed,
      model: MODEL,
      _raw: rawText.slice(0, 200),
      _tokens: { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens },
    });
  } catch (e) {
    const totalMs = Date.now() - scoreStart;
    const timedOut = e.name === 'AbortError';
    log('error', `🎯 Score ${timedOut ? 'timed out' : 'errored'}`, {
      id,
      ms: `${totalMs}ms`,
      error: e.message,
    });
    res.status(timedOut ? 504 : 500).json({
      error: timedOut ? 'LLM request timed out' : e.message,
      journeyId: id,
    });
  } finally {
    releaseSlot(id);
  }
});

// ── /score/batch  (up to 10 journeys) ────────────────────────────────────────
app.post('/score/batch', async (req, res) => {
  const journeys = req.body?.journeys;
  if (!Array.isArray(journeys) || !journeys.length) {
    log('warn', '/score/batch — missing journeys array');
    return res.status(400).json({ error: 'Missing journeys array' });
  }

  const batch = journeys.slice(0, 10);
  const batchStart = Date.now();
  log('info', '📦 Batch scoring started', { count: batch.length, ids: batch.map((j) => j.id).join(',') });

  const results = [];
  for (let i = 0; i < batch.length; i += 1) {
    const journey = batch[i];
    const { id, name, status } = journey;
    const itemStart = Date.now();

    log('info', `📦 Batch [${i + 1}/${batch.length}]`, {
      id,
      name: (name || '').slice(0, 35),
      status,
    });

    await acquireSlot(id);
    try {
      const prompt = buildPrompt(journey);
      const { text: rawText, promptTokens, completionTokens } = await callOllama(prompt, id);
      const parsed = extractJson(rawText, id);
      const itemMs = Date.now() - itemStart;

      // Write per-journey LLM log file
      writeLlmFile(journey, prompt, rawText, parsed, itemMs);

      if (parsed) {
        log('info', `📦 Batch [${i + 1}/${batch.length}] done`, {
          id,
          ms: `${itemMs}ms`,
          score: parsed.retirementScore,
          verdict: parsed.retirementLabel,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
        });
      } else {
        log('warn', `📦 Batch [${i + 1}/${batch.length}] parse failed`, { id, ms: `${itemMs}ms` });
      }

      results.push({
        journeyId: id,
        ...(parsed || { error: 'parse-failed', raw: rawText.slice(0, 200) }),
        model: MODEL,
        _tokens: { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens },
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
  const ok = results.filter((r) => !r.error).length;
  const failed = results.length - ok;
  log('info', '📦 Batch complete', {
    total: batch.length,
    ok,
    failed,
    ms: `${totalMs}ms`,
    avg_ms: `${Math.round(totalMs / batch.length)}ms`,
  });

  res.json({ results });
});

// ── /stats  (session token usage) ────────────────────────────────────────────
app.get('/stats', (_req, res) => {
  const uptime = Math.round((Date.now() - new Date(tokenStats.startedAt).getTime()) / 1000);
  const stats = {
    ...tokenStats,
    totalTokens: tokenStats.totalPromptTokens + tokenStats.totalCompletionTokens,
    uptimeSeconds: uptime,
    model: MODEL,
  };
  log('info', '📊 Stats requested', {
    requests: stats.totalRequests,
    prompt_tokens: stats.totalPromptTokens,
    completion_tokens: stats.totalCompletionTokens,
    total_tokens: stats.totalTokens,
  });
  res.json(stats);
});

// ── /stats/reset  (clear session counters) ───────────────────────────────────
app.post('/stats/reset', (_req, res) => {
  tokenStats.totalRequests = 0;
  tokenStats.totalPromptTokens = 0;
  tokenStats.totalCompletionTokens = 0;
  tokenStats.startedAt = new Date().toISOString();
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
  console.log('─'.repeat(48));
  log('info', 'Server listening', { port: PORT, url: `http://localhost:${PORT}` });
  log('info', 'Ollama backend', { url: OLLAMA_BASE, model: MODEL });
  log('info', 'Queue settings', { concurrency: LLM_CONCURRENCY, timeout_ms: REQUEST_TIMEOUT_MS });
  if (LOG_FILE) log('info', 'Log file', { path: path.resolve(LOG_FILE) });
  if (LLM_LOG_DIR) log('info', 'LLM log dir', { path: LLM_LOG_DIR });
  console.log('');
  console.log('\x1b[2mEndpoints:\x1b[0m');
  console.log(`  \x1b[36mGET  \x1b[0mhttp://localhost:${PORT}/health`);
  console.log(`  \x1b[36mPOST \x1b[0mhttp://localhost:${PORT}/score          { journey: {...} }`);
  console.log(`  \x1b[36mPOST \x1b[0mhttp://localhost:${PORT}/score/batch    { journeys: [...] }`);
  console.log(`  \x1b[36mGET  \x1b[0mhttp://localhost:${PORT}/stats           token usage counters`);
  console.log(`  \x1b[36mPOST \x1b[0mhttp://localhost:${PORT}/stats/reset     reset counters`);
  console.log('');
  console.log('\x1b[2mOptional env vars:\x1b[0m');
  console.log(`  PORT=${PORT}   OLLAMA_BASE=${OLLAMA_BASE}   MODEL=${MODEL}`);
  console.log(`  CONCURRENCY=${LLM_CONCURRENCY}   LOG_FILE=./proxy.log   LOG_LEVEL=debug|info|warn|error`);
  console.log(`  LLM_LOG_DIR=./llm-logs  (one .log file written per journey when set)`);
  console.log('');
});
