/**
 * AJO Journey Cleanup — AI Proxy Server
 *
 * Phase 1: bridges browser → Ollama (local)
 * Phase 2: swap OLLAMA_BASE_URL + MODEL to point at Claude / OpenAI / Adobe AI
 *
 * Usage:
 *   cd ai-proxy && npm install && node server.js
 *   Optional env vars:
 *     PORT=3001           (default: 3001)
 *     OLLAMA_BASE=http://localhost:11434  (default)
 *     MODEL=llama3        (default; try mistral, phi3, gemma2)
 *     CONCURRENCY=1       (Ollama is single-threaded; keep at 1)
 */

const express = require('express');
const cors = require('cors');

const PORT = parseInt(process.env.PORT || '3001', 10);
const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://localhost:11434';
const MODEL = process.env.MODEL || 'llama3';
const LLM_CONCURRENCY = parseInt(process.env.CONCURRENCY || '1', 10);
const REQUEST_TIMEOUT_MS = 60_000; // 60 s — local LLMs can be slow

const app = express();

// ── CORS: allow browser on any localhost port (aem up uses 3000) ──────────────
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || /^http:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json({ limit: '2mb' })); // journey JSON can be large

// ── simple in-memory queue (serialise requests to Ollama) ────────────────────
let activeCount = 0;
const waitQueue = [];

function acquireSlot() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (activeCount < LLM_CONCURRENCY) { activeCount += 1; resolve(); }
      else { waitQueue.push(tryAcquire); }
    };
    tryAcquire();
  });
}

function releaseSlot() {
  activeCount -= 1;
  if (waitQueue.length) waitQueue.shift()();
}

// ── call Ollama /api/generate ─────────────────────────────────────────────────
async function callOllama(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
    return data.response || '';
  } finally {
    clearTimeout(timer);
  }
}

// ── extract JSON from LLM response (LLMs sometimes wrap in markdown) ─────────
function extractJson(raw) {
  // Try direct parse first
  try { return JSON.parse(raw.trim()); } catch (_) { /* fall through */ }
  // Strip ```json ... ``` fences
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (_) { /* fall through */ }
  }
  // Extract first {...} block
  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) {
    try { return JSON.parse(brace[0]); } catch (_) { /* fall through */ }
  }
  return null;
}

// ── build scoring prompt ──────────────────────────────────────────────────────
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

  // Journey structure fields (from detail API, may be absent in list-only mode)
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
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`);
    const data = await r.json();
    const models = (data.models || []).map((m) => m.name);
    res.json({ status: 'ok', model: MODEL, ollama: 'connected', availableModels: models });
  } catch (e) {
    res.status(503).json({ status: 'error', model: MODEL, ollama: 'unreachable', error: e.message });
  }
});

// ── /score  (single journey) ──────────────────────────────────────────────────
app.post('/score', async (req, res) => {
  const journey = req.body?.journey;
  if (!journey || !journey.id) {
    return res.status(400).json({ error: 'Missing journey object with id' });
  }

  await acquireSlot();
  try {
    const prompt = buildPrompt(journey);
    const raw = await callOllama(prompt);
    const parsed = extractJson(raw);

    if (!parsed) {
      return res.status(422).json({
        error: 'LLM returned non-JSON response',
        raw: raw.slice(0, 500),
        fallback: true,
      });
    }

    res.json({
      journeyId: journey.id,
      ...parsed,
      model: MODEL,
      _raw: raw.slice(0, 200), // debug snippet
    });
  } catch (e) {
    const timedOut = e.name === 'AbortError';
    res.status(timedOut ? 504 : 500).json({
      error: timedOut ? 'LLM request timed out' : e.message,
      journeyId: journey.id,
    });
  } finally {
    releaseSlot();
  }
});

// ── /score/batch  (up to 10 journeys) ────────────────────────────────────────
app.post('/score/batch', async (req, res) => {
  const journeys = req.body?.journeys;
  if (!Array.isArray(journeys) || !journeys.length) {
    return res.status(400).json({ error: 'Missing journeys array' });
  }
  const batch = journeys.slice(0, 10); // safety cap

  // Process sequentially within this request (queue handles global concurrency)
  const results = [];
  for (const journey of batch) {
    await acquireSlot();
    try {
      const prompt = buildPrompt(journey);
      const raw = await callOllama(prompt);
      const parsed = extractJson(raw);
      results.push({
        journeyId: journey.id,
        ...(parsed || { error: 'parse-failed', raw: raw.slice(0, 200) }),
        model: MODEL,
      });
    } catch (e) {
      results.push({ journeyId: journey.id, error: e.message });
    } finally {
      releaseSlot();
    }
  }
  res.json({ results });
});

// ── start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🤖 AJO AI Proxy  →  http://localhost:${PORT}`);
  console.log(`   Ollama:  ${OLLAMA_BASE}`);
  console.log(`   Model:   ${MODEL}`);
  console.log(`   Queue:   max ${LLM_CONCURRENCY} concurrent LLM call(s)\n`);
  console.log('Endpoints:');
  console.log(`  GET  http://localhost:${PORT}/health`);
  console.log(`  POST http://localhost:${PORT}/score          { journey: {...} }`);
  console.log(`  POST http://localhost:${PORT}/score/batch    { journeys: [...] }\n`);
});
