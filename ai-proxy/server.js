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

// ── Ollama availability tracking ──────────────────────────────────────────────
let ollamaOnline = false;
let ollamaLastChecked = null;
const OLLAMA_CHECK_INTERVAL_MS = 15_000; // check every 15 s

async function checkOllamaAvailability() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5_000);
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    const wasOffline = !ollamaOnline;
    ollamaOnline = r.ok;
    ollamaLastChecked = new Date().toISOString();
    if (wasOffline && ollamaOnline) {
      log('info', '🦙 Ollama came online', { url: OLLAMA_BASE });
    }
  } catch (_) {
    const wasOnline = ollamaOnline;
    ollamaOnline = false;
    ollamaLastChecked = new Date().toISOString();
    if (wasOnline) {
      log('warn', '🦙 Ollama went offline — proxy requests will be rejected', { url: OLLAMA_BASE });
    }
  }
}

// Run immediately then on interval
checkOllamaAvailability();
setInterval(checkOllamaAvailability, OLLAMA_CHECK_INTERVAL_MS);

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
  log('info', '🦙 Ollama prompt text', { journeyId, prompt });

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

// ── Journey type name-based inference ────────────────────────────────────────
function inferJourneyTypeFromName(name) {
  const n = name || '';
  if (/abandon.?cart|cart.?abandon/i.test(n)) return 'Abandoned Cart';
  if (/\bonboard/i.test(n)) return 'Onboarding';
  if (/\bwelcome\b/i.test(n)) return 'Welcome';
  if (/re.?engag|win.?back|laps|reactivat/i.test(n)) return 'Re-engagement';
  if (/\bretention\b|\bchurn\b/i.test(n)) return 'Retention';
  if (/transact|receipt|confirm|order.?confirm/i.test(n)) return 'Transactional';
  if (/\bpromo\b|campaign|offer|discount|sale\b/i.test(n)) return 'Promotional';
  if (/\btest\b|\bpoc\b|\bdemo\b|\bsandbox\b|\bqa\b|\buat\b/i.test(n)) return 'Test/POC';
  return null;
}

// ── Canvas node extractor ─────────────────────────────────────────────────────
// AJO Journey Detail API returns nodes in various structures depending on version:
//   • journey.canvas.nodes[]  with node.type / node.nodeType
//   • journey.nodes[]         (some API versions)
//   • journey.actions[] / journey.events[] / journey.conditions[]  (pre-processed)
// We normalise all of them into three flat arrays.

const ACTION_TYPES = /action|message|email_message|email|sms|push|custom_action|custom|wait|timer|channel|inapp|iam|contentcard|content.?card|directmail|web.?action|code.?based/i;
const EVENT_TYPES  = /^(unitary_event|read_segment|audience_entry|event|trigger|audience|entry|segment)/i;
const COND_TYPES   = /^condition/i;
const END_TYPES    = /^end$/i;

function extractNodes(journey) {
  // 1) Already pre-classified arrays (from older proxy versions / test mocks)
  if (
    (journey.actions && journey.actions.length)
    || (journey.events && journey.events.length)
    || (journey.conditions && journey.conditions.length)
  ) {
    return {
      actions: journey.actions || [],
      events: journey.events || [],
      conditions: journey.conditions || [],
      allNodes: [],
    };
  }

  // 2) Flat node list at journey.nodes  or  journey.canvas.nodes
  let rawNodes = [];
  if (Array.isArray(journey.canvas?.nodes) && journey.canvas.nodes.length) {
    rawNodes = journey.canvas.nodes;
  } else if (Array.isArray(journey.nodes) && journey.nodes.length) {
    rawNodes = journey.nodes;
  } else if (journey.canvas?.nodes && typeof journey.canvas.nodes === 'object') {
    // Some API versions return nodes as a keyed object { nodeId: nodeObj, … }
    rawNodes = Object.values(journey.canvas.nodes);
  }

  if (rawNodes.length) {
    const typeOf = (n) => (n.type || n.nodeType || n.actionType || n.eventType || '').toLowerCase();
    // End nodes should not be counted in any category
    const nonEnd     = rawNodes.filter((n) => !END_TYPES.test(typeOf(n)));
    const events     = nonEnd.filter((n) => EVENT_TYPES.test(typeOf(n)));
    const conditions = nonEnd.filter((n) => COND_TYPES.test(typeOf(n)));
    const actions    = nonEnd.filter((n) => !EVENT_TYPES.test(typeOf(n)) && !COND_TYPES.test(typeOf(n)));
    log('debug', '🗂 Canvas nodes extracted', {
      total: rawNodes.length,
      non_end: nonEnd.length,
      actions: actions.length,
      events: events.length,
      conditions: conditions.length,
    });
    return { actions, events, conditions, allNodes: rawNodes };
  }

  // 3) Nothing found — return empty (list-level endpoint limitation)
  return { actions: [], events: [], conditions: [], allNodes: [] };
}

// ── Extract audience names from condition expressions ─────────────────────────
// Finds inAudience("Audience Name") patterns in condition node expressions
function extractAudienceNames(conditions) {
  const names = new Set();
  conditions.forEach((node) => {
    // Check transitions for condition expressions
    const transitions = node.transitions || [];
    transitions.forEach((t) => {
      if (t.expression) {
        const matches = t.expression.matchAll(/inAudience\(["']([^"']+)["']\)/gi);
        for (const m of matches) names.add(m[1]);
      }
    });
    // Also check expression directly on node
    if (node.expression) {
      const matches = node.expression.matchAll(/inAudience\(["']([^"']+)["']\)/gi);
      for (const m of matches) names.add(m[1]);
    }
  });
  return [...names];
}

// ── Extract event trigger type from entry event nodes ─────────────────────────
function extractTriggerInfo(events) {
  if (!events.length) return null;
  const trigger = events[0];
  const type = (trigger.type || trigger.nodeType || '').toLowerCase();
  const name = trigger.name || '';
  if (type === 'read_segment' || type === 'audience_entry') return `Audience-based (read segment): "${name}"`;
  if (type === 'unitary_event') return `Event-triggered (unitary): "${name}"`;
  return `"${name}" (type: ${type})`;
}

// ── Extract channel summary from action nodes (by node type) ──────────────────
function extractChannelSummary(actions) {
  const typeOf = (n) => (n.type || n.nodeType || n.actionType || '').toLowerCase();
  const emailCount       = actions.filter((a) => /email_message|^email$/i.test(typeOf(a))).length;
  const smsCount         = actions.filter((a) => /\bsms\b/i.test(typeOf(a))).length;
  const pushCount        = actions.filter((a) => /\bpush\b/i.test(typeOf(a))).length;
  const inAppCount       = actions.filter((a) => /inapp|in.app|\biam\b/i.test(typeOf(a))).length;
  const contentCardCount = actions.filter((a) => /content.?card/i.test(typeOf(a))).length;
  const directMailCount  = actions.filter((a) => /direct.?mail/i.test(typeOf(a))).length;
  const webCount         = actions.filter((a) => /web.?action|\bweb\b/i.test(typeOf(a))).length;
  const codeBasedCount   = actions.filter((a) => /code.?based/i.test(typeOf(a))).length;
  const timerCount       = actions.filter((a) => /\btimer\b|\bwait\b/i.test(typeOf(a))).length;
  const customCount      = actions.filter((a) => /custom_action|\bcustom\b/i.test(typeOf(a))).length;
  return {
    emailCount, smsCount, pushCount, inAppCount, contentCardCount,
    directMailCount, webCount, codeBasedCount, timerCount, customCount,
  };
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
  const lastDeployedBy = meta.lastDeployedBy || '';
  const lastDeployedAt = meta.lastDeployedAt ? meta.lastDeployedAt.slice(0, 10) : '';
  const isDefaultName = journey._isDefaultName ? 'YES — user never renamed it (strong abandonment signal)' : 'No';

  // ── Extra journey configuration fields ────────────────────────────────────
  const sandboxName = journey.sandboxName || journey.sandbox || '';
  const category = journey.category || '';
  // Journey type (unitary = event-triggered, read_segment = audience batch)
  const journeyApiType = journey.type || '';

  // Schedule — AJO API uses startDate/timezone (not startTime/start)
  const sched = journey.schedule || {};
  const schedStart = sched.startDate
    ? String(sched.startDate).slice(0, 10)
    : (sched.startTime ? String(sched.startTime).slice(0, 10) : (sched.start ? String(sched.start).slice(0, 10) : ''));
  const schedEnd = sched.endDate
    ? String(sched.endDate).slice(0, 10)
    : (sched.endTime ? String(sched.endTime).slice(0, 10) : (sched.end ? String(sched.end).slice(0, 10) : ''));
  const schedTimezone = sched.timezone || sched.timeZone || journey.timeZone || '';
  const schedUseProfileTz = sched.useProfileTimezone != null ? sched.useProfileTimezone : null;
  const schedType = sched.type || sched.scheduleType || '';
  const schedParts = [
    schedType || (schedStart ? 'scheduled' : ''),
    schedStart ? `starts ${schedStart}` : '',
    schedEnd ? `ends ${schedEnd}` : '',
    schedTimezone ? `tz: ${schedTimezone}` : '',
    schedUseProfileTz === true ? 'uses profile timezone' : '',
  ].filter(Boolean);
  const schedLine = schedParts.length ? schedParts.join(', ') : 'none / unknown';

  // Reentrance policy
  const reentrance = journey.reentrance || {};
  const reentPolicy = reentrance.policy || '';
  const reentDuration = reentrance.durationInSecs != null ? `${reentrance.durationInSecs}s window` : '';
  const reentLine = reentPolicy
    ? `${reentPolicy}${reentDuration ? ' (' + reentDuration + ')' : ''}`
    : 'none / unknown';

  // Entry configuration
  const entryCfg = journey.entryConfiguration || journey.entryConfig || {};
  const entryLimit = entryCfg.entryLimit != null ? String(entryCfg.entryLimit) : '';
  const reEntryCriteria = entryCfg.reEntryCriteria || entryCfg.reentry || '';
  const entryLine = [
    entryLimit ? `limit: ${entryLimit}` : '',
    reEntryCriteria ? `re-entry criteria: ${reEntryCriteria}` : '',
  ].filter(Boolean).join(', ') || 'none / unknown';

  // Exit criteria
  const exitArr = Array.isArray(journey.exitCriteria) ? journey.exitCriteria : (journey.exitCriteria ? [journey.exitCriteria] : []);
  const exitLine = exitArr.length
    ? exitArr.map((x) => x.type || x.condition || JSON.stringify(x)).join('; ')
    : 'none / unknown';

  // Timeouts
  const timeouts = journey.timeouts || {};
  const timeoutLine = (timeouts.actionExecution != null || timeouts.entityEnrichment != null)
    ? `action: ${timeouts.actionExecution || '?'}s, enrichment: ${timeouts.entityEnrichment || '?'}s`
    : '';

  const { actions, events, conditions, allNodes } = extractNodes(journey);

  // Safely serialize tags — AJO returns tag objects {id, name}, not plain strings
  const rawTags = journey.tags || [];
  const tagNames = rawTags
    .map((t) => {
      if (typeof t === 'string') return t;
      // Only use name/label/title if non-null and non-empty
      return (t.name && t.name.trim()) || (t.label && t.label.trim()) || (t.title && t.title.trim()) || null;
    })
    .filter(Boolean);

  const description = journey.description || '';

  // audienceId may live at top level or inside a canvas read-segment node
  const audienceId = journey.audienceId
    || journey.segmentId
    || journey.segment?.id
    || (events.find((e) => e.segmentId || e.audienceId) || {}).segmentId
    || (events.find((e) => e.segmentId || e.audienceId) || {}).audienceId
    || '';

  // ── Channel counts using improved extractor ────────────────────────────────
  const {
    emailCount, smsCount, pushCount, inAppCount, contentCardCount,
    directMailCount, webCount, codeBasedCount, timerCount, customCount,
  } = extractChannelSummary(actions);

  // ── Audience names from condition expressions ──────────────────────────────
  // Scan all nodes (conditions have transitions with expressions)
  const allForAudience = allNodes.length ? allNodes : [...actions, ...events, ...conditions];
  const audienceNames = extractAudienceNames(allForAudience);

  // ── Entry trigger info ─────────────────────────────────────────────────────
  const triggerInfo = extractTriggerInfo(events);

  // ── Condition names (the business logic labels) ────────────────────────────
  const conditionNames = conditions
    .map((c) => c.name || '')
    .filter(Boolean)
    .slice(0, 10); // cap at 10

  // ── Action node names (email/custom action names) ─────────────────────────
  const actionNames = actions
    .map((a) => a.name || '')
    .filter((n) => n && !/^(wait|timer)/i.test(n))
    .slice(0, 8);

  const nodeCount = actions.length + events.length + conditions.length;

  // ── Trim raw nodes for LLM context (keep only meaningful fields) ──────────
  const NODE_FIELDS = ['id', 'type', 'nodeType', 'actionType', 'name', 'label',
    'expression', 'channelType', 'waitDuration', 'waitUnit', 'transitions',
    'eventType', 'segmentId', 'audienceId'];
  const MAX_NODES = 50;
  const trimmedNodes = allNodes.length > 0
    ? allNodes.slice(0, MAX_NODES).map((n) => {
      const out = {};
      NODE_FIELDS.forEach((k) => { if (n[k] != null) out[k] = n[k]; });
      // Trim transitions — only keep type, condition/expression, name
      if (Array.isArray(out.transitions)) {
        out.transitions = out.transitions.map((t) => {
          const tt = {};
          if (t.type != null) tt.type = t.type;
          if (t.name != null) tt.name = t.name;
          if (t.condition != null) tt.condition = t.condition;
          if (t.expression != null) tt.expression = t.expression;
          return tt;
        });
      }
      return out;
    })
    : [];

  // Name-based type hint — strong signal even when structure is empty
  const nameTypeHint = inferJourneyTypeFromName(name);
  const nameHintLine = nameTypeHint
    ? `- Journey type inferred from name: "${nameTypeHint}" (use this as strong signal)`
    : '- Journey type inferred from name: unclear — use other signals';

  // Structural data availability note
  const structureNote = nodeCount === 0
    ? '⚠ No structural node data available (list-level endpoint) — rely on name, status, tags, and description for classification.'
    : '';

  // Build raw node section (only when structural data exists)
  const rawNodeSection = trimmedNodes.length > 0
    ? `\nRAW NODE LIST (${trimmedNodes.length} of ${allNodes.length} canvas nodes — use for deeper classification):\n${JSON.stringify(trimmedNodes)}\n`
    : '';

  return `You are an Adobe Journey Optimizer governance expert reviewing journeys for retirement.

JOURNEY METADATA:
- Name: "${name}"
- Status: ${status} | Version: ${version} | Days stale: ${daysStale}
- Journey execution type: ${journeyApiType || 'unknown'} (unitary = event-triggered; read_segment = audience batch)
- Created by: ${createdBy} on ${createdAt}
- Last modified by: ${modifiedBy} on ${modifiedAt}
${lastDeployedBy ? `- Last deployed by: ${lastDeployedBy} on ${lastDeployedAt}` : ''}
- Name is AJO default (never renamed by user): ${isDefaultName}
${nameHintLine}
${sandboxName ? `- Sandbox: ${sandboxName}` : ''}
${category ? `- Category: ${category}` : ''}

JOURNEY CONFIGURATION:
- Schedule: ${schedLine}
- Re-entrance policy: ${reentLine}
- Entry configuration: ${entryLine}
- Exit criteria: ${exitLine}
${timeoutLine ? `- Timeouts: ${timeoutLine}` : ''}

JOURNEY STRUCTURE:
- Total non-end nodes: ${nodeCount}${structureNote ? '\n  ' + structureNote : ''}
- Entry trigger: ${triggerInfo || 'none / unknown'}
- Actions: ${actions.length} total (${[
    emailCount       ? `email: ${emailCount}`              : '',
    smsCount         ? `SMS: ${smsCount}`                  : '',
    pushCount        ? `push: ${pushCount}`                : '',
    inAppCount       ? `in-app: ${inAppCount}`             : '',
    contentCardCount ? `content card: ${contentCardCount}` : '',
    directMailCount  ? `direct mail: ${directMailCount}`   : '',
    webCount         ? `web: ${webCount}`                  : '',
    codeBasedCount   ? `code-based: ${codeBasedCount}`     : '',
    timerCount       ? `timer/wait: ${timerCount}`         : '',
    customCount      ? `custom: ${customCount}`            : '',
  ].filter(Boolean).join(', ') || 'none'})
${actionNames.length ? `- Action names: ${actionNames.join(' | ')}` : ''}
- Conditions/branches: ${conditions.length}
${conditionNames.length ? `- Condition names: ${conditionNames.join(' | ')}` : ''}
- Audience segments checked in conditions: ${audienceNames.length ? audienceNames.join(', ') : 'none detected'}
- Has audience/segment: ${audienceId ? 'YES (' + audienceId + ')' : 'No'}
- Has description: ${description ? 'YES: "' + description.slice(0, 200) + '"' : 'No'}
- Tags: ${tagNames.length ? tagNames.join(', ') : 'none'}
${rawNodeSection}
SCORING CONTEXT:
- Score 80-100 = strong candidate for retirement/archiving
- Score 50-79  = uncertain, needs human review
- Score 0-49   = likely active, keep for now
- A journey with AJO default name + draft/stopped + 90+ days stale with 0 actions is almost certainly safe to retire
- A journey with real audience checks, named conditions, multiple actions, and a descriptive name is likely paused for a reason even if stopped
- Stopped journeys with full node structure (conditions, actions, audience checks) are NOT the same as abandoned/empty journeys
- When structure data is empty (0 nodes), ALWAYS infer journeyType from the journey NAME and TAGS
- Only use useCaseSummary = "Unable to determine use case" if the name is completely generic (e.g. "Journey1076") AND tags/description provide no context

TASK: Determine if this journey serves a real business purpose or is safe to retire.
Consider ALL available signals: name, execution type, node structure, audience segments, condition names, action names, schedule, reentrance policy.

Return ONLY valid JSON (no markdown fences, no explanation outside the JSON object):
{
  "journeyType": "Welcome|Promotional|Transactional|Re-engagement|Abandoned Cart|Onboarding|Retention|Test/POC|Unknown",
  "useCaseSummary": "Infer from name, condition names, audience segments, and action names what this journey does. Be specific.",
  "targetAudience": "brief description of who this journey targets based on audience segments/conditions/name, or 'Unknown'",
  "businessValue": "low|medium|high",
  "hasBusinessPurpose": true or false,
  "businessPurpose": "one sentence inferred from structure/name/context, or 'No identifiable business purpose'",
  "retirementScore": 0-100,
  "retirementLabel": "Safe to Retire|Review First|Keep Active",
  "confidence": 0-100,
  "reasoning": "2-3 sentences explaining your verdict, referencing the specific signals you used (name, audience checks, condition logic, action count, status, staleness)",
  "recommendation": "Archive|Review with owner|Keep|Contact owner before deleting"
}`;
}

// ── /health ───────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const start = Date.now();
  // Force a live probe so /health always reflects current state
  await checkOllamaAvailability();
  const ms = Date.now() - start;
  if (ollamaOnline) {
    try {
      const r = await fetch(`${OLLAMA_BASE}/api/tags`);
      const data = await r.json();
      const models = (data.models || []).map((m) => m.name);
      log('info', '🩺 Health check', {
        ollama: 'connected',
        model: MODEL,
        available_models: models.join(',') || '(none)',
        ms: `${ms}ms`,
      });
      return res.json({ status: 'ok', model: MODEL, ollama: 'connected', availableModels: models, lastChecked: ollamaLastChecked });
    } catch (e) {
      // fall through
    }
  }
  log('error', '🩺 Health check failed — Ollama unreachable', { ms: `${ms}ms` });
  res.status(503).json({ status: 'error', model: MODEL, ollama: 'unreachable', lastChecked: ollamaLastChecked });
});

// ── /score  (single journey) ──────────────────────────────────────────────────
app.post('/score', async (req, res) => {
  if (!ollamaOnline) {
    log('warn', '/score — rejected: Ollama is offline', { url: OLLAMA_BASE, lastChecked: ollamaLastChecked });
    return res.status(503).json({
      error: 'AI backend (Ollama) is currently offline. Please start Ollama and try again.',
      ollama: 'unreachable',
      lastChecked: ollamaLastChecked,
    });
  }

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
  if (!ollamaOnline) {
    log('warn', '/score/batch — rejected: Ollama is offline', { url: OLLAMA_BASE, lastChecked: ollamaLastChecked });
    return res.status(503).json({
      error: 'AI backend (Ollama) is currently offline. Please start Ollama and try again.',
      ollama: 'unreachable',
      lastChecked: ollamaLastChecked,
    });
  }

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
