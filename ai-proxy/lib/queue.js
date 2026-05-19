/**
 * lib/queue.js — Ollama HTTP client, concurrency queue, token stats, JSON extractor
 */

'use strict';

const { log } = require('./logger');

const OLLAMA_BASE        = process.env.OLLAMA_BASE       || 'http://localhost:11434';
const MODEL              = process.env.MODEL             || 'llama3';
const LLM_CONCURRENCY    = parseInt(process.env.CONCURRENCY || '1', 10);
const REQUEST_TIMEOUT_MS = 60_000;

// ── Token usage counters ──────────────────────────────────────────────────────
const tokenStats = {
  totalRequests:         0,
  totalPromptTokens:     0,
  totalCompletionTokens: 0,
  startedAt:             new Date().toISOString(),
};

// ── Concurrency queue ─────────────────────────────────────────────────────────
let activeCount  = 0;
const waitQueue  = [];

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
            journeyId, active: activeCount, waiting: waitQueue.length + 1, concurrency: LLM_CONCURRENCY,
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
  if (waitQueue.length) waitQueue.shift()();
}

// ── Ollama HTTP call ──────────────────────────────────────────────────────────
async function callOllama(prompt, journeyId) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start      = Date.now();

  log('debug', '🦙 Ollama → sending prompt', { journeyId, model: MODEL, prompt_chars: prompt.length });
  log('info',  '🦙 Ollama prompt text', { journeyId, prompt });

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: MODEL, prompt, stream: false }),
      signal:  controller.signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status}: ${txt}`);
    }

    const data = await res.json();
    const ms   = Date.now() - start;

    log('info', '🦙 Ollama ← response received', {
      journeyId, ms: `${ms}ms`, response_chars: (data.response || '').length, eval_count: data.eval_count,
    });

    const responseText     = data.response || '';
    const promptTokens     = data.prompt_eval_count || 0;
    const completionTokens = data.eval_count || 0;

    tokenStats.totalRequests         += 1;
    tokenStats.totalPromptTokens     += promptTokens;
    tokenStats.totalCompletionTokens += completionTokens;

    log('info', '🦙 Ollama tokens', {
      journeyId,
      prompt_tokens:     promptTokens,
      completion_tokens: completionTokens,
      total_tokens:      promptTokens + completionTokens,
      session_total:     tokenStats.totalPromptTokens + tokenStats.totalCompletionTokens,
    });
    log('debug', '🦙 Ollama raw response', { journeyId, raw_response: responseText });

    return { text: responseText, promptTokens, completionTokens };
  } catch (e) {
    const ms = Date.now() - start;
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
    try { return JSON.parse(fence[1].trim()); } catch (_) { /* fall through */ }
  }

  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) {
    try { return JSON.parse(brace[0]); } catch (_) { /* fall through */ }
  }

  log('warn', 'JSON parse failed — LLM returned non-JSON', {
    journeyId, raw_preview: raw.slice(0, 120).replace(/\n/g, ' '),
  });
  return null;
}

// ── Ollama availability check ─────────────────────────────────────────────────
let ollamaOnline      = false;
let ollamaLastChecked = null;
const OLLAMA_CHECK_INTERVAL_MS = 15_000;

async function checkOllamaAvailability() {
  try {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 5_000);
    const r    = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    const wasOffline = !ollamaOnline;
    ollamaOnline     = r.ok;
    ollamaLastChecked = new Date().toISOString();
    if (wasOffline && ollamaOnline) log('info', '🦙 Ollama came online', { url: OLLAMA_BASE });
  } catch (_) {
    const wasOnline = ollamaOnline;
    ollamaOnline     = false;
    ollamaLastChecked = new Date().toISOString();
    if (wasOnline) log('warn', '🦙 Ollama went offline', { url: OLLAMA_BASE });
  }
}

// Start availability polling
checkOllamaAvailability();
setInterval(checkOllamaAvailability, OLLAMA_CHECK_INTERVAL_MS);

function getOllamaStatus() {
  return { online: ollamaOnline, lastChecked: ollamaLastChecked, base: OLLAMA_BASE, model: MODEL };
}

function resetTokenStats() {
  tokenStats.totalRequests         = 0;
  tokenStats.totalPromptTokens     = 0;
  tokenStats.totalCompletionTokens = 0;
  tokenStats.startedAt             = new Date().toISOString();
}

module.exports = {
  callOllama,
  extractJson,
  acquireSlot,
  releaseSlot,
  tokenStats,
  resetTokenStats,
  checkOllamaAvailability,
  getOllamaStatus,
  OLLAMA_BASE,
  MODEL,
  LLM_CONCURRENCY,
};
