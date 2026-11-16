/**
 * lib/queue.js — LLM client (Ollama + Azure OpenAI), concurrency queue, token stats, JSON extractor
 */

'use strict';

const { log } = require('./logger');

// ── Environment Configuration ─────────────────────────────────────────────────
const LLM_PROVIDER       = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
const OLLAMA_BASE        = process.env.OLLAMA_BASE       || 'http://localhost:11434';
const MODEL              = process.env.MODEL             || 'llama3';
const LLM_CONCURRENCY    = parseInt(process.env.CONCURRENCY || '1', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '300000', 10); // 5 min default

// Azure OpenAI Configuration
const AZURE_OPENAI_ENDPOINT    = process.env.AZURE_OPENAI_ENDPOINT || '';
const AZURE_OPENAI_API_KEY     = process.env.AZURE_OPENAI_API_KEY || '';
const AZURE_OPENAI_DEPLOYMENT  = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview';

// Token limit with validation (min: 1000, max: 16000)
const AZURE_MAX_TOKENS_RAW = parseInt(process.env.AZURE_OPENAI_MAX_COMPLETION_TOKENS || '4000', 10);
const AZURE_OPENAI_MAX_COMPLETION_TOKENS = Math.max(1000, Math.min(16000, AZURE_MAX_TOKENS_RAW));
if (AZURE_MAX_TOKENS_RAW !== AZURE_OPENAI_MAX_COMPLETION_TOKENS) {
  log('warn', 'Azure max_completion_tokens clamped to valid range', {
    requested: AZURE_MAX_TOKENS_RAW,
    actual: AZURE_OPENAI_MAX_COMPLETION_TOKENS,
    range: '1000-16000',
  });
}

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

// ── Azure OpenAI HTTP call ────────────────────────────────────────────────────
async function callAzureOpenAI(prompt, journeyId) {
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY) {
    throw new Error('Azure OpenAI credentials missing. Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .env');
  }

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start      = Date.now();

  const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;

  log('debug', '☁️  Azure OpenAI → sending prompt', { 
    journeyId, 
    deployment: AZURE_OPENAI_DEPLOYMENT, 
    prompt_chars: prompt.length 
  });

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_API_KEY,
      },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: prompt }
        ],
        max_completion_tokens: AZURE_OPENAI_MAX_COMPLETION_TOKENS,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Azure OpenAI HTTP ${res.status}: ${txt}`);
    }

    const data = await res.json();
    const ms   = Date.now() - start;

    // Log the full response for debugging
    log('debug', '☁️  Azure OpenAI full response', { 
      journeyId,
      response_json: JSON.stringify(data, null, 2).substring(0, 500),
    });

    const responseText = data.choices?.[0]?.message?.content || '';
    
    // If content is empty, log the full choice object
    if (!responseText && data.choices?.[0]) {
      log('warn', '☁️  Azure OpenAI returned empty content', {
        journeyId,
        choice_object: JSON.stringify(data.choices[0], null, 2),
        finish_reason: data.choices[0].finish_reason,
      });
    }
    const usage = data.usage || {};
    const promptTokens     = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;

    log('info', '☁️  Azure OpenAI ← response received', {
      journeyId, 
      ms: `${ms}ms`, 
      response_chars: responseText.length,
      completion_tokens: completionTokens,
    });

    tokenStats.totalRequests         += 1;
    tokenStats.totalPromptTokens     += promptTokens;
    tokenStats.totalCompletionTokens += completionTokens;

    log('info', '☁️  Azure OpenAI tokens', {
      journeyId,
      prompt_tokens:     promptTokens,
      completion_tokens: completionTokens,
      total_tokens:      promptTokens + completionTokens,
      session_total:     tokenStats.totalPromptTokens + tokenStats.totalCompletionTokens,
    });
    log('debug', '☁️  Azure OpenAI raw response', { journeyId, raw_response: responseText });

    return { text: responseText, promptTokens, completionTokens };
  } catch (e) {
    const ms = Date.now() - start;
    if (e.name === 'AbortError') {
      log('error', '☁️  Azure OpenAI timeout', { journeyId, after: `${REQUEST_TIMEOUT_MS}ms` });
    } else {
      log('error', '☁️  Azure OpenAI error', { journeyId, ms: `${ms}ms`, error: e.message });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── Ollama HTTP call ──────────────────────────────────────────────────────────
async function callOllama(prompt, journeyId) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start      = Date.now();

  log('debug', '🦙 Ollama → sending prompt', { journeyId, model: MODEL, prompt_chars: prompt.length });

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

// ── Provider-agnostic LLM call ────────────────────────────────────────────────
async function callLLM(prompt, journeyId) {
  if (LLM_PROVIDER === 'azure') {
    return callAzureOpenAI(prompt, journeyId);
  } else if (LLM_PROVIDER === 'ollama') {
    return callOllama(prompt, journeyId);
  } else {
    throw new Error(`Unknown LLM_PROVIDER: ${LLM_PROVIDER}. Must be 'ollama' or 'azure'.`);
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

// ── Provider availability check ───────────────────────────────────────────────
let providerOnline      = false;
let providerLastChecked = null;
const PROVIDER_CHECK_INTERVAL_MS = 15_000;

async function checkProviderAvailability() {
  try {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 5_000);
    
    let r;
    if (LLM_PROVIDER === 'azure') {
      // For Azure, just check if we can reach the endpoint (simple HEAD or GET to base URL)
      const baseUrl = AZURE_OPENAI_ENDPOINT || '';
      if (!baseUrl) {
        throw new Error('Azure endpoint not configured');
      }
      r = await fetch(baseUrl, { 
        method: 'HEAD',
        signal: ctrl.signal 
      }).catch(() => ({ ok: false }));
    } else {
      // For Ollama, check the /api/tags endpoint
      r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: ctrl.signal });
    }
    
    clearTimeout(t);
    const wasOffline = !providerOnline;
    providerOnline     = r.ok;
    providerLastChecked = new Date().toISOString();
    
    if (wasOffline && providerOnline) {
      const provider = LLM_PROVIDER === 'azure' ? 'Azure OpenAI' : 'Ollama';
      log('info', `${LLM_PROVIDER === 'azure' ? '☁️' : '🦙'} ${provider} came online`, { 
        provider: LLM_PROVIDER,
        url: LLM_PROVIDER === 'azure' ? AZURE_OPENAI_ENDPOINT : OLLAMA_BASE 
      });
    }
  } catch (_) {
    const wasOnline = providerOnline;
    providerOnline     = false;
    providerLastChecked = new Date().toISOString();
    
    if (wasOnline) {
      const provider = LLM_PROVIDER === 'azure' ? 'Azure OpenAI' : 'Ollama';
      log('warn', `${LLM_PROVIDER === 'azure' ? '☁️' : '🦙'} ${provider} went offline`, { 
        provider: LLM_PROVIDER,
        url: LLM_PROVIDER === 'azure' ? AZURE_OPENAI_ENDPOINT : OLLAMA_BASE 
      });
    }
  }
}

// Start availability polling
checkProviderAvailability();
setInterval(checkProviderAvailability, PROVIDER_CHECK_INTERVAL_MS);

function getProviderStatus() {
  return { 
    online: providerOnline, 
    lastChecked: providerLastChecked, 
    provider: LLM_PROVIDER,
    base: LLM_PROVIDER === 'azure' ? AZURE_OPENAI_ENDPOINT : OLLAMA_BASE,
    model: LLM_PROVIDER === 'azure' ? AZURE_OPENAI_DEPLOYMENT : MODEL,
  };
}

function resetTokenStats() {
  tokenStats.totalRequests         = 0;
  tokenStats.totalPromptTokens     = 0;
  tokenStats.totalCompletionTokens = 0;
  tokenStats.startedAt             = new Date().toISOString();
}

module.exports = {
  callLLM,           // New unified interface
  callOllama,        // Keep for backward compatibility
  callAzureOpenAI,   // New Azure function
  extractJson,
  acquireSlot,
  releaseSlot,
  tokenStats,
  resetTokenStats,
  checkOllamaAvailability: checkProviderAvailability,  // Alias for backward compatibility
  checkProviderAvailability,
  getOllamaStatus: getProviderStatus,  // Alias for backward compatibility
  getProviderStatus,
  OLLAMA_BASE,
  MODEL,
  LLM_CONCURRENCY,
  LLM_PROVIDER,
  AZURE_OPENAI_DEPLOYMENT,
};
