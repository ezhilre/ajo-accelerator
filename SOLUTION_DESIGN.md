# AJO Journey Cleanup Accelerator — Detailed Solution Design Document

**Version**: 1.0  
**Date**: May 2026  
**Project**: `ajo-accelerator`

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Component Inventory](#3-component-inventory)
4. [Frontend — EDS Block (`journey-cleanup-card`)](#4-frontend--eds-block)
5. [AI Proxy Server](#5-ai-proxy-server)
6. [API Reference — All Endpoints](#6-api-reference--all-endpoints)
7. [Agent 1 — Audience Resolver](#7-agent-1--audience-resolver)
8. [Agent 2 — Journey Scorer](#8-agent-2--journey-scorer)
9. [Rule-Based Scoring Engine](#9-rule-based-scoring-engine)
10. [AI Scoring — End-to-End Flow](#10-ai-scoring--end-to-end-flow)
11. [Combined Score Calculation](#11-combined-score-calculation)
12. [Journey Analyzer Library](#12-journey-analyzer-library)
13. [Expression Parser Library](#13-expression-parser-library)
14. [LLM Client & Concurrency Queue](#14-llm-client--concurrency-queue)
15. [Logger & LLM Log Writer](#15-logger--llm-log-writer)
16. [Cache Layer — IndexedDB Snapshots](#16-cache-layer--indexeddb-snapshots)
17. [Agent Pool — Frontend Orchestrator](#17-agent-pool--frontend-orchestrator)
18. [Data Flow — Full Request Lifecycle](#18-data-flow--full-request-lifecycle)
19. [LLM Prompt Engineering Deep Dive](#19-llm-prompt-engineering-deep-dive)
20. [Scoring Output Schema](#20-scoring-output-schema)
21. [Configuration & Environment Variables](#21-configuration--environment-variables)
22. [Security Model](#22-security-model)
23. [Error Handling & Resilience](#23-error-handling--resilience)
24. [Performance Characteristics](#24-performance-characteristics)

---

## 1. System Overview

The AJO Journey Cleanup Accelerator is a **governance dashboard** built on Adobe Experience Delivery Services (EDS). Its purpose is to identify, analyze, and recommend retirement actions for stale Adobe Journey Optimizer (AJO) journeys — those not modified in 30+ days.

The system combines two complementary scoring approaches:

| Layer | Name | Method | Speed | Location |
|---|---|---|---|---|
| **Layer 1** | Rule-Based Score | Deterministic heuristics on metadata | Instant | Browser |
| **Layer 2** | AI Score | Local LLM (Ollama) via AI Proxy | ~30–120s per journey | Server |

The two scores are **blended** into a single Combined Score (0–100) that drives the final governance recommendation:

| Combined Score | Decision | Color |
|---|---|---|
| ≥ 80 | 🔴 Retire / Archive | Red |
| 50–79 | 🟡 Review First | Yellow |
| < 50 | 🟢 Keep Active | Green |

### Key Design Principles

1. **Credentials never leave the browser** — AJO API calls are made directly from the browser using user-provided `sessionStorage` credentials.
2. **AI proxy runs locally** — Ollama runs on `localhost:11434`; the Node.js proxy bridges browser→Ollama without sending journey data to cloud services.
3. **Graceful degradation** — Rule scoring works without the AI proxy. Audience resolution works without Adobe UPS credentials. LLM scoring works without audience data.
4. **Snapshot caching** — IndexedDB stores a full analysis snapshot per sandbox. Subsequent visits load instantly from cache (90-day staleness threshold triggers re-analysis prompt).

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        BROWSER  (EDS Page)                               │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │              journey-cleanup-card  (EDS Block)                   │    │
│  │                                                                   │    │
│  │   journey-cleanup-card.js          jcc-ai-core.js               │    │
│  │    • Dashboard UI / pagination      • Rule engine                │    │
│  │    • Filter / sort / CSV export     • Agent pool (4 workers)     │    │
│  │    • AJO API pagination             • Proxy HTTP calls           │    │
│  │    • Credential modal               • UI rendering helpers       │    │
│  │                                                                   │    │
│  │   jcc-cache.js (IndexedDB)                                       │    │
│  │    • saveSnapshot / loadSnapshot                                  │    │
│  │    • Per-sandbox snapshot with 90-day staleness                  │    │
│  └────────────────┬────────────────────────────┬────────────────────┘    │
└───────────────────│────────────────────────────│────────────────────────-┘
                    │                            │
        Direct browser fetch                HTTP to AI Proxy
        (Bearer token in header)            POST /score, /audience/resolve
                    │                            │
                    ▼                            ▼
┌───────────────────────────┐    ┌──────────────────────────────────────────┐
│  Adobe Journey Optimizer  │    │  AI Proxy Server  (Node.js / Express)    │
│  REST API                 │    │  ai-proxy/server.js  :3001               │
│                           │    │                                           │
│  GET /ajo/journey         │    │  ┌────────────────────────────────────┐  │
│    ?pageSize=50           │    │  │ Agent 1 — Audience Resolver        │  │
│    &filter=status=draft.. │    │  │ agents/audience-agent.js           │  │
│                           │    │  │  1. Fetch from Adobe UPS API       │  │
│  GET /ajo/journey/{id}    │    │  │  2. Normalize PQL/AST expression   │  │
└───────────────────────────┘    │  │  3. LLM → plain-English sentence   │  │
                                 │  └──────────────────┬─────────────────┘  │
┌───────────────────────────┐    │                     │                    │
│  Adobe UPS API            │◄───┤  Adobe UPS calls    │                    │
│  (Segmentation Service)   │    │  (server-side,       │                    │
│                           │    │   no CORS issue)     │                    │
│  GET /data/core/ups/      │    │                     ▼                    │
│     audiences/{id}        │    │  ┌────────────────────────────────────┐  │
└───────────────────────────┘    │  │ Agent 2 — Journey Scorer           │  │
                                 │  │ agents/scoring-agent.js            │  │
                                 │  │  1. Build rich scoring prompt      │  │
                                 │  │  2. Call Ollama LLM                │  │
                                 │  │  3. Parse structured JSON          │  │
                                 │  └──────────────────┬─────────────────┘  │
                                 │                     │                    │
                                 │  Support Libraries  │                    │
                                 │  lib/journey-analyzer.js                 │
                                 │  lib/expression-parser.js                │
                                 │  lib/queue.js  (Ollama client)           │
                                 │  lib/logger.js                           │
                                 └─────────────────────┬────────────────────┘
                                                       │
                                                 Ollama HTTP API
                                                 POST /api/generate
                                                       │
                                                       ▼
                                            ┌─────────────────────┐
                                            │  Ollama  :11434     │
                                            │  Model: llama3      │
                                            │  (or configurable)  │
                                            └─────────────────────┘
```

---

## 3. Component Inventory

| File | Layer | Responsibility |
|---|---|---|
| `blocks/journey-cleanup-card/journey-cleanup-card.js` | Frontend | Main dashboard UI, AJO API pagination, filter/sort/search, CSV export, credential modal |
| `blocks/journey-cleanup-card/jcc-ai-core.js` | Frontend | Rule engine, agent pool orchestrator, proxy HTTP calls, UI badge/detail HTML generators |
| `blocks/journey-cleanup-card/jcc-cache.js` | Frontend | IndexedDB snapshot persistence (save / load / clear per sandbox) |
| `blocks/journey-cleanup-card/journey-cleanup-card.css` | Frontend | All dashboard component styles |
| `ai-proxy/server.js` | Backend | Express app, all REST routes, request middleware, credential resolution, journey enrichment |
| `ai-proxy/agents/audience-agent.js` | Backend | Agent 1 — UPS API fetch, PQL normalization, LLM plain-English description |
| `ai-proxy/agents/scoring-agent.js` | Backend | Agent 2 — prompt construction, Ollama call, JSON response parsing |
| `ai-proxy/lib/journey-analyzer.js` | Backend | Pure-JS canvas node extraction, flow-path builder (BFS+DFS), intent pre-deriver |
| `ai-proxy/lib/expression-parser.js` | Backend | Adobe UPS PQL/AST → simplified intermediate JSON normalizer (deterministic, no LLM) |
| `ai-proxy/lib/queue.js` | Backend | Ollama HTTP client, concurrency semaphore, token usage counters, JSON extractor |
| `ai-proxy/lib/logger.js` | Backend | Structured color console logger, optional file logger, per-journey `.log` file writer |

---

## 4. Frontend — EDS Block

### 4.1 Entry Point

The EDS `decorate(block)` function is the single entry point. It calls `initApp(root)`:

```javascript
export default function decorate(block) {
  block.innerHTML = '';
  initApp(block);
}
```

`initApp` checks `sessionStorage["jcc_cfg"]` for saved credentials, then navigates to the appropriate screen.

### 4.2 Navigation State Machine

```
┌──────────────────────────────────────────────────────────┐
│  showPreDash()         No credentials found              │
│    "Configure Credentials" → showModal()                 │
└──────────────────────────────┬───────────────────────────┘
                               │ onOk(cfg)
                               ▼
┌──────────────────────────────────────────────────────────┐
│  showModal()           Credential entry modal            │
│    Validates 5 fields, calls verifyCredentials()         │
│    (live API call: GET /ajo/journey?pageSize=1)           │
│    Shows connection status, saves to sessionStorage      │
└──────────────────────────────┬───────────────────────────┘
                               │ onOk(cfg)
                               ▼
┌──────────────────────────────────────────────────────────┐
│  showModeSelect()      Mode selection                    │
│    [Analyze All]  →  showDashboard()                     │
│    [By Journey ID] → showJourneyIdLookup()               │
└──────────────────────────────┬───────────────────────────┘
                               │ "Analyze All"
                               ▼
┌──────────────────────────────────────────────────────────┐
│  showDashboard()       Cache check                       │
│    loadSnapshot(sandbox) from IndexedDB                  │
│    → If cached: showCacheBanner() → user choice          │
│      'cache' → showDashboardCore(initialJourneys,scores) │
│      'fresh' → showDashboardCore(null, null)             │
│      'clear' → clearSnapshot() → showDashboardCore()    │
│    → If no cache: showDashboardCore(null, null)          │
└──────────────────────────────┬───────────────────────────┘
                               │
                               ▼
                     showDashboardCore()
                     (live interactive dashboard)
```

### 4.3 Credential Model

Credentials reside in `sessionStorage` only — cleared when the browser tab closes.

```json
{
  "token":    "Bearer eyJ...",
  "apiKey":   "xxxxxxxxxxxxxxxx",
  "orgId":    "XXXXX@AdobeOrg",
  "sandbox":  "prod",
  "tenantId": "my-tenant"
}
```

`tenantId` is used exclusively to construct AJO deep-link URLs:
```
https://experience.adobe.com/#/@{tenantId}/sname:{sandbox}/journey-optimizer/journeys/journey/{id}
```

AI proxy URL and `enabled` flag are persisted in `localStorage["jcc_ai"]` (survives tab close).

### 4.4 AJO API Pagination (`fetchAll`)

Fetches `GET https://platform.adobe.io/ajo/journey` iteratively across all pages (50 items/page).

**Filter applied:**
```
status=draft,failed,stopped,closed,finished,live,deployed
&metadata.lastModifiedAt<{today-ISO}
```

**Lifecycle callbacks:**
| Callback | Triggered when |
|---|---|
| `onChunk(chunk, cumulative, pageNum, totalFromApi)` | Each page arrives |
| `onErr(error)` | Network or HTTP error |
| `onDone(finalArray)` | All pages fetched |

Rule scores are applied to each chunk **immediately on arrival** — the table populates progressively as data loads.

Fetch is controlled by `AbortController` — the user can stop mid-fetch using the ⏹ Stop button.

### 4.5 Dashboard Filtering & Sorting

**Filters:**

| Filter | Options |
|---|---|
| Status | All / Draft / Failed / Finished / Stopped |
| Owner | All / dynamic list built from `metadata.createdBy` values |
| AI Category | All / 🔴 Retire / 🟡 Review / 🟢 Keep |
| Age Bucket | All / 0–30d / 31–60d / 61–90d / 90+ |
| Search | Full-text match on: name, id, status, sandboxName, version, createdBy, lastModifiedBy |

**Sort keys:** Last Modified · Created At · Name · Status · **AI Score** (sorted descending by risk)

**Staleness staleness age calculation:**
```javascript
daysAgo(iso) = floor((Date.now() - new Date(iso).getTime()) / 86400000)
```

Stale threshold is `STALE_DAYS = 30`. Journeys with `lastModifiedAt < 30 days ago` are shown.

### 4.6 CSV Export

Two export buttons:
- **All CSV** — every stale journey in the loaded dataset
- **Filtered CSV** — current filter/sort result

CSV columns: ID, Name, Status, Version, Sandbox, Created By, Created At, Last Modified By, Last Modified At, Days Stale, Rule Score, AI Score (Blended), AI Verdict, Journey Type, Use Case Summary, Target Audience, Business Value, Has Business Purpose, Business Purpose, AI Reasoning, Recommendation, AI Confidence, AJO URL.

---

## 5. AI Proxy Server

**File**: `ai-proxy/server.js`  
**Framework**: Express.js  
**Port**: `3001` (configurable via `PORT` env var)

### 5.1 CORS Policy

The proxy accepts requests from:
1. Requests with no `Origin` header (server-to-server)
2. `localhost` (any port) — for local development
3. `*.aem.live` and `*.aem.page` — AEM/EDS CDN origins (pattern: `/^https?:\/\/(localhost(:\d+)?|[a-z0-9-]+--[a-z0-9-]+--[a-z0-9-]+\.aem\.(live|page))`)
4. Extra origins from `ALLOWED_ORIGINS` env var (comma-separated)

All other origins receive a CORS error.

### 5.2 Middleware Chain

```
CORS middleware
  → express.json({ limit: '2mb' })
  → requestLogger (logs method, path, IP, status, duration)
  → Routes (GET /health, POST /audience/resolve, POST /score, POST /score/batch, GET /stats, POST /stats/reset)
  → 404 handler
  → Global error handler
```

### 5.3 Credential Resolution

Per-request Adobe credentials are resolved with this priority:

```javascript
effectiveCfg(reqCfg) = {
  token:   reqCfg.token   || process.env.ADOBE_TOKEN,
  apiKey:  reqCfg.apiKey  || process.env.ADOBE_API_KEY,
  orgId:   reqCfg.orgId   || process.env.ADOBE_ORG_ID,
  sandbox: reqCfg.sandbox || process.env.ADOBE_SANDBOX,
}
```

Request body credentials take priority over env vars. This allows per-request override without restarting the server.

### 5.4 Journey Enrichment (`enrichJourney`)

Before any agent runs, two computed fields are attached:

| Field | Calculation |
|---|---|
| `_daysStale` | `Math.floor((Date.now() - new Date(lastModifiedAt)) / 86400000)` |
| `_isDefaultName` | `Boolean(name && /^Journey\s*[\-_]?\s*\d+\s*(v\d+)?$/i.test(name.trim()))` |

### 5.5 Audience Extraction (`extractAllAudiences`)

Scans 5 locations in the journey object for audience references, deduplicating by `id`:

| Location | Field Path |
|---|---|
| 1 | `journey.audiences[]` |
| 2 | `journey.canvas.nodes[].audiences[]` |
| 3 | `journey.nodes[].audiences[]` |
| 4 | `journey.canvas.nodes[].audienceId` / `.segmentId` |
| 5 | `journey.audienceId` / `journey.segmentId` / `journey.segment.id` |

Returns `[{id, name}]` with deduplication via `Map<id, audience>`.

### 5.6 Ollama Availability Polling

`lib/queue.js` polls `GET {OLLAMA_BASE}/api/tags` every **15 seconds**. The `online` flag is checked at the start of every `/score` and `/score/batch` request — if offline, the proxy returns `503` immediately without queuing.

---

## 6. API Reference — All Endpoints

### `GET /health`

Checks Ollama connectivity and lists available models.

**Response 200:**
```json
{
  "status": "ok",
  "model": "llama3",
  "ollama": "connected",
  "availableModels": ["llama3", "mistral"],
  "lastChecked": "2026-05-19T14:30:00.000Z",
  "adobeCredentials": true
}
```

**Response 503:**
```json
{ "status": "error", "model": "llama3", "ollama": "unreachable", "lastChecked": "..." }
```

---

### `POST /audience/resolve`

Standalone audience resolution. Fetches UPS definitions, normalizes expressions, generates plain-English descriptions.

**Request Body:**
```json
{
  "audiences": [
    { "id": "abc-123-...", "name": "High Value Users" }
  ],
  "cfg": {
    "token": "Bearer eyJ...",
    "apiKey": "xxxxx",
    "orgId": "XXXXX@AdobeOrg",
    "sandbox": "prod"
  }
}
```

**Response 200:**
```json
{
  "resolved": [
    {
      "id": "abc-123-...",
      "name": "High Value Users",
      "apiStatus": "resolved",
      "durationMs": 1240,
      "normalized": {
        "type": "AND",
        "conditions": [
          { "type": "CONDITION", "field": "geo.country", "operator": "=", "value": "US" },
          { "type": "CONDITION", "field": "purchaseCount", "operator": ">", "value": 3 }
        ]
      },
      "plainEnglish": "US-based users who have completed more than 3 purchases.",
      "llmPrompt": "You are a marketing analyst...",
      "llmRaw": "US-based users who...",
      "error": null
    }
  ]
}
```

`apiStatus` values: `pending` | `resolved` | `fetch-failed`

**Error 400:** Missing audiences array or missing Adobe credentials.  
**Error 500:** Unexpected server error.

---

### `POST /score`

Scores a single journey through both Agent 1 (Audience Resolver) and Agent 2 (Journey Scorer).

**Request Body:**
```json
{
  "journey": {
    "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "name": "Welcome Series v2",
    "status": "draft",
    "version": "2",
    "type": "unitary",
    "sandboxName": "prod",
    "metadata": {
      "createdBy": "marketer@company.com",
      "createdAt": "2025-10-01T09:00:00.000Z",
      "lastModifiedAt": "2025-12-15T11:30:00.000Z",
      "lastModifiedBy": "marketer@company.com",
      "lastDeployedBy": "",
      "lastDeployedAt": ""
    },
    "canvas": {
      "startNodeId": "node-1",
      "nodes": [
        {
          "id": "node-1", "type": "audience_entry", "name": "New Mobile Users",
          "transitions": [{ "nextNodeId": "node-2" }]
        },
        {
          "id": "node-2", "type": "condition", "name": "Free vs Paid",
          "transitions": [
            { "nextNodeId": "node-3", "name": "Free User" },
            { "nextNodeId": "node-4", "name": "Paid User" }
          ]
        },
        { "id": "node-3", "type": "inapp", "name": "Upsell Modal" },
        { "id": "node-4", "type": "email_message", "name": "Welcome Email" }
      ]
    },
    "audiences": [{ "id": "seg-abc", "name": "New Mobile Users" }],
    "schedule": {},
    "reentrance": { "policy": "noReentrance" },
    "exitCriteria": []
  },
  "cfg": {
    "token": "Bearer eyJ...",
    "apiKey": "xxxxx",
    "orgId": "XXXXX@AdobeOrg",
    "sandbox": "prod"
  }
}
```

**Response 200:**
```json
{
  "journeyId": "3fa85f64-...",
  "journeyType": "Welcome",
  "lifecycleStage": "Onboarding",
  "customerExperience": "New mobile users receive personalized onboarding based on subscription status.",
  "behaviorTargeted": "First subscription upgrade or initial product activation.",
  "businessObjective": "Convert free mobile users to paid subscribers within the first 7 days.",
  "whyTeamBuiltThis": "To segment new users immediately and serve relevant monetization or value-reinforcement messages.",
  "useCaseSummary": "Audience-qualified entry splits new mobile users into free vs paid, delivering an upsell modal to free users and a welcome email to paid users.",
  "targetAudience": "New mobile app users — split by subscription state (Free vs Paid).",
  "businessValue": "high",
  "businessPurpose": "New user monetization and onboarding activation for mobile subscribers.",
  "retirementScore": 12,
  "retirementLabel": "Keep Active",
  "confidence": 91,
  "reasoning": "This journey has a clear free/paid segmentation with targeted in-app messaging for conversion, indicating active monetization strategy. Draft status with 155-day staleness may reflect a pipeline journey, but the structural richness and business intent (upsell + welcome split) firmly places this in Keep territory.",
  "lifecycleDecision": "Keep",
  "governanceReviewPriority": "low",
  "recommendation": "Keep",
  "model": "llama3",
  "_raw": "{\"journeyType\": \"Welcome\", \"lifecycleStage\": \"Onboarding\"...",
  "_tokens": { "prompt": 1540, "completion": 420, "total": 1960 },
  "_audiences": [
    {
      "id": "seg-abc",
      "name": "New Mobile Users",
      "plainEnglish": "Users who installed the mobile app within the last 30 days.",
      "status": "resolved"
    }
  ]
}
```

**Error responses:**

| Code | Condition |
|---|---|
| `400` | Missing `journey` object or missing `journey.id` |
| `422` | LLM returned non-JSON response (includes `fallback: true`, `raw: "..."`) |
| `503` | Ollama offline |
| `504` | LLM request timed out (>120s) |
| `500` | Unexpected error |

---

### `POST /score/batch`

Scores up to 10 journeys sequentially. Each journey goes through the full Agent 1 → Agent 2 pipeline.

**Request Body:**
```json
{
  "journeys": [ {...}, {...} ],
  "cfg": { "token": "...", "apiKey": "...", "orgId": "...", "sandbox": "..." }
}
```

**Response 200:**
```json
{
  "results": [
    {
      "journeyId": "uuid-1",
      "retirementScore": 22,
      "retirementLabel": "Keep Active",
      "lifecycleDecision": "Keep",
      "model": "llama3",
      "_tokens": { "prompt": 1400, "completion": 380, "total": 1780 },
      "_audiences": []
    },
    {
      "journeyId": "uuid-2",
      "error": "LLM request timed out"
    }
  ]
}
```

Processing is **strictly sequential** — each journey waits for the previous to complete. This respects Ollama's single-threaded inference and the proxy's concurrency semaphore (default: 1).

---

### `GET /stats`

Returns token usage counters for the current server session.

**Response 200:**
```json
{
  "totalRequests": 47,
  "totalPromptTokens": 58240,
  "totalCompletionTokens": 17860,
  "totalTokens": 76100,
  "startedAt": "2026-05-19T08:00:00.000Z",
  "uptimeSeconds": 36000,
  "model": "llama3"
}
```

---

### `POST /stats/reset`

Resets all token counters to zero. Returns `{ "ok": true, "message": "Token stats reset" }`.

---

## 7. Agent 1 — Audience Resolver

**File**: `ai-proxy/agents/audience-agent.js`

Agent 1 runs a **3-step pipeline per audience** to convert raw segment IDs into human-readable business descriptions.

### 7.1 Step 1: Fetch from Adobe UPS API

```
GET {ADOBE_UPS_BASE}/audiences/{audienceId}

Headers:
  Authorization:      Bearer {token}
  x-api-key:          {apiKey}
  x-gw-ims-org-id:    {orgId}
  x-sandbox-name:     {sandbox}
  Content-Type:       application/json

Timeout: 15,000ms (AbortController)
```

**Returns**: Raw audience JSON including `expression` (PQL/AST) and metadata.

**Error handling**: Any HTTP non-OK or timeout results in `apiStatus: 'fetch-failed'` with the error captured in `result.error`. The agent continues to Step 3 with `normalized: null` (falls back to raw audience name).

### 7.2 Step 2: Normalize PQL/AST Expression

Calls `normalizeAudienceExpression(expressionData)` from `lib/expression-parser.js`.

**This step is:**
- Pure JavaScript, deterministic
- Zero LLM calls
- Handles Adobe UPS's `{ value: "<json string>" }` wrapper format

The Adobe UPS API returns expressions in two shapes:
```json
// Shape 1: value is a JSON string
{ "expressionType": "PQL", "mimeType": "pql/json", "value": "{\"nodeType\":\"fnApply\",...}" }

// Shape 2: value is already an object
{ "expressionType": "PQL", "value": { "nodeType": "fnApply", ... } }
```

Both are handled transparently by the parser.

**Output (normalized intermediate JSON):**
```json
{
  "type": "AND",
  "conditions": [
    { "type": "CONDITION", "field": "_company.geo.country", "operator": "=", "value": "US" },
    {
      "type": "SELECT_FILTER",
      "variables": [{
        "collection": "purchaseHistory",
        "filter": { "type": "CONDITION", "field": "amount", "operator": ">", "value": 100 },
        "alias": "p"
      }]
    }
  ]
}
```

### 7.3 Step 3: LLM → Plain English

**Only runs if normalized data is available.**

Prompt sent to Ollama:
```
You are a marketing analyst. Convert the following audience rule JSON into ONE clear, 
concise sentence in plain English for a business user. Do NOT describe the JSON structure 
— describe WHO qualifies for this audience and WHY.

Audience name: "{audienceName}"

Normalized audience rule:
{JSON.stringify(normalized, null, 2)}

Requirements:
- Write exactly one sentence.
- Focus on the business meaning: who the person is, what they did, and any qualifying attributes.
- Use plain language (no technical field names like "_adobe_corpnew.aviProgramV2").
- Map field path segments to readable terms (e.g. "geo" → region, "fireflyOwnershipFlag" → Firefly product ownership).

Plain English description:
```

Post-processing strips any "Plain English description:" prefix from the response.

**Fallback**: If no expression data exists, `plainEnglish` is set to the raw audience `name`.

### 7.4 Concurrency & Error Isolation

`resolveJourneyAudiences()` processes audiences in **batches of 3 concurrently** using `Promise.all`. Individual failures are captured per-audience — the function never throws. Failed audiences still appear in the resolved list with `apiStatus: 'fetch-failed'`.

### 7.5 ResolvedAudience Output Schema

```typescript
interface ResolvedAudience {
  id:           string;          // Audience UUID
  name:         string;          // Audience display name
  apiStatus:    'pending' | 'resolved' | 'fetch-failed';
  durationMs:   number;          // Total time for this audience (fetch + normalize + LLM)
  normalized:   object | null;   // Simplified intermediate JSON from expression-parser
  plainEnglish: string | null;   // One-sentence business description from LLM
  llmPrompt:    string | null;   // The exact prompt sent to the LLM
  llmRaw:       string | null;   // Raw LLM response text
  error:        string | null;   // Error message if any step failed
}
```

### 7.6 `buildAudienceDefinitionsBlock()` — Prompt Injection Helper

Formats resolved audiences as a text block injected into Agent 2's scoring prompt:

```
AUDIENCE DEFINITIONS (resolved from Adobe UPS API):
  [1] "New Mobile Users"
       → Users who installed the mobile app within the last 30 days.
  [2] "High Value Subscribers" [fetch-failed]
       → (could not resolve: Adobe UPS HTTP 404: ...)
```

---

## 8. Agent 2 — Journey Scorer

**File**: `ai-proxy/agents/scoring-agent.js`

Agent 2 transforms a journey object + resolved audiences into a structured JSON governance verdict via the LLM.

### 8.1 `buildPrompt(journey, resolvedAudiences) → string`

Assembles a ~2,000–3,500 character prompt from multiple data sources. The prompt has a **fixed structure** with these sections injected in order:

| Section | Source Function | Purpose |
|---|---|---|
| Journey Identity | `journey.metadata.*`, computed fields | Basic facts: name, status, version, days stale, creator |
| Type Hint / Pre-classification | `inferJourneyTypeFromName()` + `preClassifyJourney()` | Anchors journey type with explicit override instruction |
| Business Intent Signals | `deriveIntentLayer()` | Pre-derived lifecycle/intent/channel signals |
| Audience Definitions | `buildAudienceDefinitionsBlock(resolved)` | Plain-English audience descriptions from Agent 1 |
| Customer Lifecycle Context | `schedule`, `reentrance`, `exitCriteria` fields | Operational parameters |
| Journey Flow | `buildFlowPath()` | Human-readable BFS+DFS traversal of canvas nodes |
| Workflow Structure | `buildJourneyStructure()` | Node counts, branch counts, channel breakdown, complexity |
| Node Labels | Extracted `actions[]`, `events[]`, `conditions[]` | Named workflow elements (first 8–10) |
| Target Audience | `buildAudienceSummary()` | Entry qualification and segmentation logic |
| Operational State | `buildOperationalSignals()` | Last published date, schedule, stopped status |
| Governance Rules | Hardcoded in prompt | LLM scoring constraints and calibration |
| Output Schema | Hardcoded JSON template | Forces structured JSON response |

### 8.2 Governance Rules Injected into the Prompt

The prompt contains explicit priority-ordered rules to constrain LLM reasoning:

```
GOVERNANCE RULES (apply in priority order):
1. INTENT IS PRIMARY. Interpret purpose from flow structure, audience names,
   condition names, and channel choices.
2. Draft ≠ abandoned. A draft with entry logic + branching + message actions
   has deliberate business purpose.
3. Staleness influences retirement urgency only — not whether the journey
   had a legitimate purpose.
4. Name tokens (test/copy/delete/old/v2) are WEAK signals. Strong structural
   evidence overrides naming completely.
5. If journey has >=1 entry event AND >=1 condition AND >=1 message action
   → describe the real business intent.
6. Test/POC requires: placeholder name AND trivial structure (<=1 node, no
   audience logic, no messaging).
```

### 8.3 Scoring Calibration Examples

Three concrete examples are embedded in the prompt to anchor the LLM's scoring scale:

```
SCORING EXAMPLES:
- Onboarding + free/paid audience split + 4 IAM actions + wait timer + draft + 65d stale
  → retirementScore: 20, lifecycleDecision: "Keep"
- Named journey + rich conditions + email sequence + audience segments + stopped 8 months ago
  → retirementScore: 45, lifecycleDecision: "Review"
- AJO default name + 0 conditions + 0 message actions + 400d stale + no description
  → retirementScore: 92, lifecycleDecision: "Archive"
```

### 8.4 Workflow Richness Floors

Embedded in the prompt as hard constraints for the LLM:

```
WORKFLOW RICHNESS CALIBRATION:
- Rich lifecycle workflow = audience qualification + condition branching + 2+
  message actions + timing/wait steps
  → retirementScore MUST be ≤ 35, regardless of draft status or staleness up to 120 days
- Monetization signals (free/paid split, subscription branching, upsell targeting):
  → floor retirementScore at ≤ 25
- Onboarding + activation + app-timing patterns with multiple IAM/push actions:
  → floor retirementScore at ≤ 30
```

### 8.5 `scoreJourney()` — Execution Flow

```javascript
async function scoreJourney(journey, resolvedAudiences) {
  // 1. Build comprehensive prompt
  const prompt = buildPrompt(journey, resolvedAudiences);
  
  // 2. Call Ollama LLM (via queue.js semaphore)
  const { text: rawText, promptTokens, completionTokens } = await callOllama(prompt, id);
  
  // 3. Parse JSON from LLM response (3-strategy extraction)
  const parsed = extractJson(rawText, id);
  
  // 4. Return all intermediates (for logging and response)
  return { parsed, rawText, promptTokens, completionTokens, prompt };
}
```

### 8.6 JSON Extraction Strategy (`extractJson`)

The LLM response is parsed using 3 fallback strategies in sequence:

1. **Direct parse**: `JSON.parse(raw.trim())`
2. **Fenced code block**: Extracts from ` ```json ... ``` ` or ` ``` ... ``` `
3. **Brace extraction**: Finds first `{...}` substring and parses it

If all three fail, returns `null` and the route returns `422` with `fallback: true`.

---

## 9. Rule-Based Scoring Engine

**File**: `blocks/journey-cleanup-card/jcc-ai-core.js` — `computeRuleScore(journey)`

The rule engine runs **100% in the browser**, is instant, requires no API calls, and fires before LLM scoring begins. It uses only journey list metadata (no canvas/node data needed).

### 9.1 Signal Table

| Signal | Condition | Points | Severity |
|---|---|---|---|
| AJO default name (never renamed) | `/^Journey\s*[\-_]?\s*\d+\s*(v\d+)?$/i` | +25 | critical |
| Stale indicator in name | `test\|copy\|old\|tmp\|temp\|backup\|delete\|unused\|demo\|poc\|prototype\|dummy` | +10 | warning |
| >180 days stale | `daysAgo > 180` | +35 | critical |
| >120 days stale | `daysAgo > 120` | +25 | warning |
| >90 days stale | `daysAgo > 90` | +15 | warning |
| >60 days stale | `daysAgo > 60` | +8 | ok |
| Status: failed | `status === 'failed'` | +15 | warning |
| Status: draft | `status === 'draft'` | +7 | warning |
| Status: stopped / closed | `status === 'stopped' \|\| 'closed'` | +8 | ok |
| Version 1 (never iterated) | `parseInt(version) <= 1` | +8 | ok |

Score is **capped at 100** (`Math.min(100, rawSum)`).

### 9.2 Label Mapping

| Score Range | Label | Color |
|---|---|---|
| ≥ 80 | Safe to Retire | red |
| 50–79 | Review First | yellow |
| < 50 | Likely Active | green |

### 9.3 Output Schema

```typescript
interface RuleScore {
  score:   number;    // 0–100
  label:   string;    // "Safe to Retire" | "Review First" | "Likely Active"
  color:   string;    // "red" | "yellow" | "green"
  signals: Array<{
    label:  string;   // Human-readable signal description
    points: number;   // Points added by this signal
    type:   string;   // "critical" | "warning" | "ok"
  }>;
}
```

---

## 10. AI Scoring — End-to-End Flow

### 10.1 Single Journey Score Request

```
Browser                    AI Proxy (:3001)          Ollama (:11434)    Adobe UPS API
   │                              │                         │                  │
   │── POST /score ───────────────►                         │                  │
   │   { journey, cfg }           │                         │                  │
   │                          enrichJourney()               │                  │
   │                          (_daysStale, _isDefaultName)  │                  │
   │                          extractAllAudiences()         │                  │
   │                              │                         │                  │
   │                         ┌────────────────────────────────────────────┐   │
   │                         │  AGENT 1 — AUDIENCE RESOLVER               │   │
   │                         │                                            │   │
   │                         │  for each audience (3 concurrent):         │   │
   │                         │── GET /audiences/{id} ──────────────────────────►
   │                         │◄── audience JSON ────────────────────────────────│
   │                         │  normalizeAudienceExpression()             │   │
   │                         │── POST /api/generate (plain-English) ──────►   │
   │                         │◄── one sentence ───────────────────────────│   │
   │                         └────────────────────────────────────────────┘   │
   │                              │                         │                  │
   │                         ┌────────────────────────────────────────────┐   │
   │                         │  AGENT 2 — JOURNEY SCORER                  │   │
   │                         │                                            │   │
   │                         │  buildPrompt(journey, resolvedAudiences)   │   │
   │                         │  • extractNodes (canvas traversal)         │   │
   │                         │  • buildFlowPath (BFS+DFS)                 │   │
   │                         │  • deriveIntentLayer                       │   │
   │                         │  • buildJourneyStructure                   │   │
   │                         │  • buildAudienceDefinitionsBlock           │   │
   │                         │── POST /api/generate (scoring) ────────────►  │
   │                         │◄── JSON response ──────────────────────────│  │
   │                         │  extractJson (3-strategy parse)            │   │
   │                         │  writeLlmFile (./llm-logs/*.log)           │   │
   │                         └────────────────────────────────────────────┘   │
   │                              │                         │                  │
   │◄── 200 { retirementScore,    │                         │                  │
   │         retirementLabel,     │                         │                  │
   │         lifecycleDecision,   │                         │                  │
   │         _audiences, ... } ───│                         │                  │
```

### 10.2 Concurrency Semaphore Detail

```javascript
// lib/queue.js
let activeCount = 0;          // Currently running Ollama requests
const waitQueue = [];         // Pending requests (FIFO)

acquireSlot(journeyId):
  if (activeCount < LLM_CONCURRENCY):  activeCount++; resolve()
  else:  waitQueue.push(tryAcquire)    // Block until slot freed

releaseSlot(journeyId):
  activeCount--
  if (waitQueue.length):  waitQueue.shift()()  // Unblock next waiter
```

Default `LLM_CONCURRENCY = 1` — ensures Ollama processes one request at a time.

### 10.3 Request Timeout

Each `callOllama()` call uses `AbortController` with **120,000ms timeout** (2 minutes). On abort, `e.name === 'AbortError'` triggers a `504` response with message `"LLM request timed out"`.

---

## 11. Combined Score Calculation

### 11.1 Standard Blend (most journeys)

```
combinedScore = round(rule.score × 0.40 + llm.retirementScore × 0.60)
```

### 11.2 High-Value Override

When a journey shows **strong business value evidence** (`llm.businessValue === 'high'` AND `llm.retirementScore ≤ 40`), LLM evidence dominates to prevent staleness/naming penalties from overriding business intent:

```
combinedScore = round(rule.score × 0.20 + llm.retirementScore × 0.80)
```

### 11.3 Fallback (no LLM)

```
combinedScore = rule.score
```

### 11.4 Score → Category Mapping

| Combined Score | Category | Icon | Tally Counter |
|---|---|---|---|
| ≥ 80 | Retire | 🔴 | `retireCount` |
| 50–79 | Review | 🟡 | `reviewCount` |
| < 50 | Keep | 🟢 | `keepCount` |

### 11.5 UI Display in `scoreBadgeHtml()`

The badge shows the **combined score** with the verdict label:
- `AI+Rule: 34/100 (confidence: 91%)` — when LLM available
- `Rule-based: 58/100` — rule only

`aiDetailHtml()` renders a 3-section expandable panel:
1. **What this journey does** — lifecycle stage badge, journey type badge, use-case summary, audience, customer experience, behavior targeted, business objective, why it was built
2. **Why the AI thinks this** — score bar (0–100), business value chip, governance priority, reasoning text, recommendation callout
3. **Rule signals** — individual signal breakdown with points and severity

---

## 12. Journey Analyzer Library

**File**: `ai-proxy/lib/journey-analyzer.js`

Pure JavaScript, zero side effects, no LLM calls. All functions are called by `buildPrompt()` in Agent 2 to construct the scoring prompt sections.

### 12.1 `extractNodes(journey)` → `{actions, events, conditions, allNodes}`

Handles 4 canvas data shapes from the AJO API:

| Shape | Condition | Handling |
|---|---|---|
| Pre-flattened | `journey.actions.length > 0` | Uses `journey.actions`, `.events`, `.conditions` directly |
| Canvas array | `journey.canvas.nodes` is Array | Classifies each node by type regex |
| Canvas object | `journey.canvas.nodes` is Object | `Object.values()` then classifies |
| Flat nodes | `journey.nodes` is Array | Classifies each node by type regex |

**Node classification regexes:**
- **Events**: `/^(unitary_event|read_segment|audience_entry|event|trigger|audience|entry|segment)/i`
- **Conditions**: `/^condition/i`
- **End nodes**: `/^end$/i` — filtered out of all counts
- **Actions**: everything else (not event, not condition, not end)

### 12.2 `extractChannelSummary(actions)` → Channel Counts

| Counter | Regex |
|---|---|
| `emailCount` | `/email_message\|^email$/i` |
| `smsCount` | `/\bsms\b/i` |
| `pushCount` | `/\bpush\b/i` |
| `inAppCount` | `/inapp\|in.app\|\biam\b/i` |
| `contentCardCount` | `/content.?card/i` |
| `directMailCount` | `/direct.?mail/i` |
| `webCount` | `/web.?action\|\bweb\b/i` |
| `codeBasedCount` | `/code.?based/i` |
| `timerCount` | `/\btimer\b\|\bwait\b/i` |
| `customCount` | `/custom_action\|\bcustom\b/i` |

### 12.3 `buildFlowPath(journey)` → `{flowText, maxDepth}`

**Phase 1 — BFS for max depth:**  
Breadth-first traversal from `startNodeId` following `transitions[].nextNodeId` edges. Computes the maximum distance (in hops) from entry to any leaf node.

**Phase 2 — DFS for human-readable text:**  
Depth-first walk with:
- **Cycle detection**: `pathAncestors` Set prevents infinite loops → renders `...(loop back)`
- **Convergence detection**: `renderedCache` Map prevents re-rendering shared nodes → renders `→ (converges to: NodeName)`
- **Depth limit**: Stops at depth 20 → renders `...(depth limit)`
- **Branch labeling**: Condition transitions are labeled with their `name`/`label`/`type`
- **Inline chaining**: Single-child nodes are chained on the same line with ` -> `

**Example output:**
```
Audience Entry: New Mobile Users [entry point]
Condition: Free vs Paid [2 branches]
   [Free User] -> In-App: Upsell Modal [in-app] -> Wait: 3 day [timing gate]
      -> Condition: Clicked CTA [2 branches]
         [Yes] -> In-App: Confirmation [in-app] -> End
         [No] -> End
   [Paid User] -> Email: Welcome Email [email] -> End
```

**Node label generation** maps `type` to readable labels:
- `audience_entry` / `read_segment` → `"Audience Entry: {name} [entry point]"`
- `unitary_event` → `"Event Trigger: {name} [entry point]"`
- `condition` → `"Condition: {name} [N branches]"`
- `timer` / `wait` → `"Wait: {duration} {unit} [timing gate]"`
- `inapp` / `iam` → `"In-App: {name} [in-app]"`
- `email_message` → `"Email: {name} [email]"`
- `sms` → `"SMS: {name} [sms]"`
- `push` → `"Push Notification: {name} [push]"`

### 12.4 `buildJourneyStructure()` — Metrics Block

Produces a formatted multi-line structure summary injected into the scoring prompt:

```
- Total nodes:               12 | Complexity: HIGH
- Branch count:              4 (3 condition nodes)
- Max path depth (BFS):      8 steps
- Message touchpoints:       YES (in-app: 2, email: 1, push: 1)
- Wait/timing steps:         YES (2)
- Audience qualification:    YES
- Named audience segments:   Free Users, Paid Users
- Personalized segmentation: YES
- Has description:           YES
- Empty/shell structure:     no
```

Complexity levels:
- **HIGH**: `totalNodes >= 8` OR `totalBranches >= 3`
- **MEDIUM**: `totalNodes >= 4` OR `totalBranches >= 1`
- **LOW**: otherwise

### 12.5 `deriveIntentLayer()` — Business Intent Pre-derivation

Derives 7 business signals from journey name + node labels + flow text using regex pattern matching. Output is injected into the prompt as a pre-derived context block:

```
- Lifecycle stage       : Onboarding / First activation
- Primary intent        : Guide new users through activation milestones
- Segmentation type     : Subscription-state split (Free vs Paid users)
- Engagement channel    : in-app messages (real-time contextual) + email (2-touch sequence)
- Timing strategy       : Short-term trigger response (3 day) — immediate post-action nurture
- Customer problem      : New users need guided activation to realize product value
- Behavioral target     : First key action or feature activation in the app
```

**Signal derivation rules (partial):**

| Signal | Pattern | Derived Value |
|---|---|---|
| Lifecycle stage | `/onboard/i` in any text | Onboarding |
| Lifecycle stage | `/upsell\|upgrade\|premium\|paid/i` | Monetization / Upsell |
| Primary intent | `/free.*paid\|paid.*free\|upsell/i` | Drive conversion from free to paid |
| Segmentation | Audience names contain `/free\|paid\|subscri/i` | Subscription-state split |
| Timing | Wait duration from flowText `match(/wait: (\d+) (day\|hour)/gi)` | Short/medium/long-term nurture |

The LLM is explicitly instructed: **"use as context, override if flow contradicts"**.

### 12.6 `preClassifyJourney()` — Name-Aware Type Hint

Combines name patterns with structural evidence to produce a typed hint:

```
Pre-classification: "Welcome" (rule confidence: 90% — confirm or override based on structure)
```

| Pattern + Condition | Type | Confidence |
|---|---|---|
| `/abandon.?cart/i` + email or SMS | Abandoned Cart | 92% |
| `/\bonboard/i` + any messaging | Onboarding | 90% |
| `/\bwelcome\b/i` + any messaging | Welcome | 90% |
| `/re.?engag\|win.?back/i` + messaging | Re-engagement | 88% |
| `/\bretention\|churn/i` + messaging | Retention | 88% |
| Event-triggered + email + no conditions | Transactional | 85% |
| `/\btest\|poc\|demo/i` + ≤2 nodes | Test/POC | 90% |

---

## 13. Expression Parser Library

**File**: `ai-proxy/lib/expression-parser.js`

Converts Adobe UPS PQL/AST expressions into a simplified intermediate JSON for LLM consumption.

### 13.1 Supported AST Node Types

| `nodeType` | Output Type | Description |
|---|---|---|
| `fnApply` (and/or) | `AND` / `OR` | Logical combinators with `conditions` array |
| `fnApply` (stringCompare) | `CONDITION` | String field comparison |
| `fnApply` (=, !=, <, >, <=, >=) | `CONDITION` | Numeric/equality comparison |
| `fnApply` (inAudience) | `AUDIENCE_MEMBERSHIP` | Audience membership check |
| `fnApply` (select) | `SELECT_FILTER` | Sub-collection filtering |
| `select` | `SELECT_FILTER` | Collection filter (standalone) |
| `fieldLookup` | `FIELD` | Field path reference |
| `literal` | `VALUE` | Literal value (scalar or list) |
| `varRef` | `VAR_REF` | Variable reference |
| `varDecl` | `VAR_DECL` | Variable declaration with collection + filter |
| `parameterReference` | `PARAM` | Parameter position reference |
| `chain` | `CHAIN` | Sequential operations on an array |
| `occurs` | `OCCURS` | Temporal occurrence window |
| `lambda` | (unwrapped) | Delegates to `normalizeNode(body)` |

### 13.2 Field Path Building

`buildFieldPath(node)` recursively traverses `fieldLookup` nodes:
```
node.object.object.fieldName + "." + node.object.fieldName + "." + node.fieldName
→ "_company.geo.country"
```

### 13.3 Entry Point: `normalizeAudienceExpression(expressionData)`

Handles the Adobe UPS wrapper format:
```javascript
// If expressionData.value is a string → JSON.parse it
// If expressionData.value is an object → use it directly
// Then call normalizeNode(node)
```

---

## 14. LLM Client & Concurrency Queue

**File**: `ai-proxy/lib/queue.js`

### 14.1 `callOllama(prompt, journeyId)` → `{text, promptTokens, completionTokens}`

**HTTP Call:**
```
POST {OLLAMA_BASE}/api/generate
Content-Type: application/json

{
  "model": "llama3",
  "prompt": "...",
  "stream": false
}
```

`stream: false` means Ollama accumulates the full response before returning — no streaming logic needed.

**Response fields used:**
- `data.response` — the generated text
- `data.prompt_eval_count` — prompt token count
- `data.eval_count` — completion token count

**Token tracking:** Every successful call increments `tokenStats`:
```javascript
tokenStats.totalRequests         += 1
tokenStats.totalPromptTokens     += promptTokens
tokenStats.totalCompletionTokens += completionTokens
```

**Timeout:** `AbortController` set to **120,000ms**. On abort, throws with `e.name === 'AbortError'`.

**Logging:** Both the full prompt text and the full response text are logged at `info` level (for debugging — configurable via `LOG_LEVEL`).

### 14.2 Concurrency Semaphore

```javascript
const LLM_CONCURRENCY = parseInt(process.env.CONCURRENCY || '1', 10);
let activeCount = 0;
const waitQueue = [];

// acquireSlot: blocks until a slot is free
// releaseSlot: frees slot and unblocks next waiter
```

With `CONCURRENCY=1`, requests are fully serialized. With `CONCURRENCY=2`, up to 2 Ollama requests run in parallel (useful for machines with multiple GPUs).

### 14.3 Availability Polling

```javascript
const OLLAMA_CHECK_INTERVAL_MS = 15_000;  // every 15 seconds

checkOllamaAvailability():
  GET {OLLAMA_BASE}/api/tags  (5s timeout)
  → sets ollamaOnline = true/false
  → logs transitions (online → offline, offline → online)

// Runs immediately at startup, then on interval
checkOllamaAvailability();
setInterval(checkOllamaAvailability, OLLAMA_CHECK_INTERVAL_MS);
```

### 14.4 `extractJson(raw, journeyId)` — 3-Strategy Parser

```javascript
// Strategy 1: Direct parse
try { return JSON.parse(raw.trim()); } catch {}

// Strategy 2: Fenced code block
const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
if (fence) try { return JSON.parse(fence[1].trim()); } catch {}

// Strategy 3: First brace-delimited JSON object
const brace = raw.match(/\{[\s\S]*\}/);
if (brace) try { return JSON.parse(brace[0]); } catch {}

// All failed → return null
```

---

## 15. Logger & LLM Log Writer

**File**: `ai-proxy/lib/logger.js`

### 15.1 `log(level, message, meta)` — Structured Console Logger

Log levels (in ascending severity): `debug` → `info` → `warn` → `error`

Controlled by `LOG_LEVEL` env var (default: `info`). Messages below the configured level are silently dropped.

**Console output format:**
```
2026-05-19T14:30:00.000Z  ✅ [INFO]  🎯 Score complete  id=3fa85f64...  ms=4200ms  verdict=Keep Active  score=22
```

Color-coded by level: debug=cyan, info=green, warn=yellow, error=red.

**Optional file output:** If `LOG_FILE` env var is set, each log line is also written as JSON to the file:
```json
{"ts":"2026-05-19T14:30:00.000Z","level":"info","message":"Score complete","id":"...","ms":"4200ms"}
```

### 15.2 `writeLlmFile(journey, prompt, raw, parsed, durationMs, audienceResults)`

Writes one `.log` file per scored journey to `LLM_LOG_DIR`.

**Filename pattern:** `{journeyId}_{safeName}_{timestamp}.log`

**File structure:**
```
Journey ID     : 3fa85f64-...
Journey Name   : Welcome Series v2
Status         : draft
Days Stale     : 155
Model          : llama3
Scored At      : 2026-05-19T14:30:00.000Z
Total Duration : 4200ms

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AGENT 1 — AUDIENCE RESOLVER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  [1] Audience ID   : seg-abc
       Name          : New Mobile Users
       API Status    : resolved
       Duration      : 1240ms
       NORMALIZED RULE: { "type": "AND", "conditions": [...] }
       PLAIN ENGLISH : Users who installed the mobile app within the last 30 days.
       LLM PROMPT: ...
       LLM RAW RESPONSE: ...


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AGENT 2 — JOURNEY SCORER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PROMPT:
--------------------------------------------------------------------------------
{full prompt text}
RAW RESPONSE:
--------------------------------------------------------------------------------
{full LLM JSON response}
PARSED RESULT:
--------------------------------------------------------------------------------
  retirementScore          : 12
  retirementLabel          : Keep Active
  confidence               : 91
  businessValue            : high
  journeyType              : Welcome
  lifecycleStage           : Onboarding
  ...
```

---

## 16. Cache Layer — IndexedDB Snapshots

**File**: `blocks/journey-cleanup-card/jcc-cache.js`

### 16.1 Database Schema

```
Database:  jcc_dashboard  (IndexedDB)
Version:   1
Store:     snapshots  (keyPath: 'sandbox')

Record shape:
{
  sandbox:       string,         // Primary key — sandbox name
  analyzedAt:    ISO string,     // When the analysis was run
  journeyCount:  number,         // Total journeys in the snapshot
  aiScoredCount: number,         // How many have LLM scores
  journeys:      Object[],       // Full AJO journey list
  aiScores:      Object          // Map serialized as plain object: { [journeyId]: { rule, llm } }
}
```

### 16.2 API

| Function | Signature | Description |
|---|---|---|
| `saveSnapshot` | `(sandbox, journeys[], Map<id,{rule,llm}>) → Promise<void>` | Saves/overwrites the sandbox snapshot |
| `loadSnapshot` | `(sandbox) → Promise<SnapshotRecord \| null>` | Loads snapshot; adds `daysOld` and `isStale` (≥90d) |
| `clearSnapshot` | `(sandbox) → Promise<void>` | Deletes the sandbox snapshot |
| `listSnapshots` | `() → Promise<SnapshotMeta[]>` | Lists all snapshots (metadata only, no journey arrays) |
| `hydrateScores` | `(aiScoresObj) → Map<id,{rule,llm}>` | Deserializes plain object back to `Map` |
| `fmtSnapshotDate` | `(iso) → string` | Formats ISO date as `"16 Apr 2026, 08:30"` |

### 16.3 Staleness Model

```
daysOld  = floor((now - new Date(analyzedAt)) / 86400000)
isStale  = daysOld >= 90
```

When `isStale = true`, the cache banner shows a ⚠ warning and the snapshot row is highlighted. The user can still load it, or choose "Run fresh analysis".

### 16.4 Auto-Save Behavior

The snapshot is automatically saved after the AI run completes. A `snapshotSaved` flag prevents double-saves (e.g., if the user re-runs AI on additional live journeys in the same session). The progress label updates to show `"— 💾 Saved to cache"`.

---

## 17. Agent Pool — Frontend Orchestrator

**File**: `blocks/journey-cleanup-card/jcc-ai-core.js` — `createAgentPool()`

The agent pool manages concurrent LLM scoring from the browser. Default concurrency: **4 workers**.

### 17.1 Architecture

```javascript
createAgentPool({ cfg, proxyUrl, concurrency=4, detailCache,
                  onScore, onProgress, onComplete, onProxyDown })

Returns: {
  enqueue(journeys[]),   // Start processing
  stop(),                // Abort all pending
  resetProxyDown()       // Reset failure counters
}
```

### 17.2 Per-Journey Processing (`processOne`)

Each worker processes one journey at a time through this pipeline:

```
processOne(journey):
  1. computeRuleScore(journey)              [instant, local]
  
  2. fetchJourneyDetail(cfg, journey.id)    [AJO API call for canvas data]
     → cached in detailCache Map (avoids re-fetching on retry)
  
  3. extractAllAudiences(mergedJourney)     [from list + detail]
  
  4. resolveAudiences(rawAudiences, cfg, proxyUrl)
     → POST {proxyUrl}/audience/resolve
     → graceful fallback: returns raw names on error
  
  5. scoreSingleLLM(mergedJourney + enrichedAudiences, proxyUrl)
     → POST {proxyUrl}/score
     → timeout: 150,000ms (2.5 min)
  
  6. tally(rule, llm) → updates retireCount, reviewCount, keepCount
  7. onScore(id, rule, llm)                [updates aiScores Map in dashboard]
  8. onProgress({ done, total, retireCount, reviewCount, keepCount })
  9. if done === total: onComplete()
```

### 17.3 Concurrency Worker Model

```javascript
enqueue(journeys):
  queue.push(...journeys)
  total = journeys.length
  workers = min(concurrency, journeys.length)  // e.g., 4 workers
  for i in range(workers): worker()

worker():
  while queue.length AND NOT stopped:
    journey = queue.shift()
    await processOne(journey)    // Each worker blocks here
```

With 4 workers and 100 journeys, 4 journeys are processed simultaneously — each worker picks the next journey from the queue when it completes.

### 17.4 High-Value Weight Logic in `tally()`

```javascript
tally(rule, llm):
  if llm AND NOT llm.error:
    isHighValue = (llm.businessValue === 'high') AND (llm.retirementScore <= 40)
    ruleWeight = isHighValue ? 0.2 : 0.4
    llmWeight  = isHighValue ? 0.8 : 0.6
    s = round(rule.score * ruleWeight + llm.retirementScore * llmWeight)
  else:
    s = rule.score
  
  if s >= 80: retireCount++
  else if s >= 50: reviewCount++
  else: keepCount++
```

### 17.5 Proxy-Down Detection

```javascript
const PROXY_DOWN_THRESHOLD = 3  // consecutive non-timeout failures

processOne():
  catch (e):
    isTimeout = e.name === 'AbortError' || 'TimeoutError'
    if NOT isTimeout:
      consecutiveFails++
      if consecutiveFails >= 3 AND NOT proxyDownFired:
        proxyDownFired = true
        onProxyDown(e.message)   // shows "Proxy Down" banner with Retry button
```

**Distinction**: Timeouts (`AbortError`) do NOT increment the failure counter — they mean Ollama is slow but the proxy is alive. Only connection errors (`ECONNREFUSED`, HTTP errors) trigger the proxy-down banner.

### 17.6 Proxy-Down Banner (Dashboard)

When `onProxyDown` fires, a sticky banner appears:
```
⚠ AI proxy stopped responding
  Connection refused or timed out
  Restart the proxy: cd ai-proxy && node server.js
  [↺ Retry AI]  [✕ Dismiss]
```

Clicking **Retry AI** re-tests the proxy and re-queues only journeys without a successful LLM score.

---

## 18. Data Flow — Full Request Lifecycle

### 18.1 Fresh Analysis (no cache)

```
1. User enters credentials → showModal() → verifyCredentials() [GET /ajo/journey?pageSize=1]
2. showModeSelect() → user clicks "Analyze All"
3. showDashboard() → loadSnapshot() returns null → showDashboardCore()
4. startLoad() → fetchAll() pages through AJO API (50 items/page)
5. Each chunk → applyRuleScores() → render table (instant scores visible)
6. fetchAll() onDone() → testProxy() → startAI(draftTargets)
7. agentPool.enqueue(targets) → 4 workers start
8. Each worker:
   a. fetchJourneyDetail() → GET /ajo/journey/{id}  [canvas/node data]
   b. POST /audience/resolve  [proxy resolves audience definitions]
   c. POST /score  [proxy runs Agent1 + Agent2 → LLM score]
   d. onScore() → aiScores.set(id, {rule, llm}) → render()
9. onComplete() → saveSnapshot() → "💾 Saved to cache"
```

### 18.2 Cached Analysis

```
1. loadSnapshot() returns record with daysOld < 90
2. showCacheBanner() → user clicks "Load from cache"
3. hydrateScores(snap.aiScores) → Map<id, {rule, llm}>
4. showDashboardCore(snap.journeys, restoredScores, snap)
5. Render table immediately — no API calls made
```

### 18.3 Single Journey Lookup

```
1. showJourneyIdLookup() → user pastes UUID
2. fetchJourneyDetail(cfg, uuid) → GET /ajo/journey/{uuid}
3. computeRuleScore(journey) → render instantly
4. if aiEnabled: scoreSingleLLM(journey, proxyUrl) → POST /score
5. renderSingleResult() with rule + LLM result
```

---

## 19. LLM Prompt Engineering Deep Dive

### 19.1 Prompt Philosophy

The prompt is designed around a key insight: **the LLM must act as a customer lifecycle strategist, not a graph topology describer**. The opening instruction sets this explicitly:

```
Your job is NOT to describe the graph topology — it is to interpret the business 
intent behind it.
A marketing or product team built this workflow deliberately. Your task is to 
articulate WHY.

Ask yourself:
  - What customer experience is this workflow trying to create?
  - What specific user behavior is being influenced or triggered?
  - What lifecycle stage does this journey target?
  - What business outcome appears to be intended?
  - Why would a marketing/product team build exactly this workflow?
```

### 19.2 Information Density Strategy

The prompt maximizes signal density by pre-deriving structured signals (`deriveIntentLayer`, `buildFlowPath`, `buildJourneyStructure`) in JavaScript **before** sending to the LLM. This means:
- The LLM receives formatted, structured context rather than raw JSON
- Token usage is more efficient (no JSON parsing required by LLM)
- The LLM's reasoning task is scoped to interpretation, not extraction

### 19.3 Output Constraint

The prompt ends with:
```
Return ONLY valid JSON — no markdown, no explanatory text outside the object.
{ ... }
```

The `extractJson()` 3-strategy parser handles cases where the LLM still wraps the JSON in markdown fences or adds preamble text.

### 19.4 Prompt Sections in Detail

**Journey Identity block** (metadata facts):
```
JOURNEY IDENTITY:
Name: "Welcome Series - Free to Paid"
Status: draft | Version: 2 | Days stale: 155
Execution type: unitary (unitary=event-triggered; read_segment=audience-batch)
Created by: marketer@company.com on 2025-10-01 | Modified by: marketer@company.com on 2025-12-15
Default AJO name (never renamed): No
Sandbox: prod
Tags: mobile, onboarding
Pre-classification: "Welcome" (rule confidence: 90% — confirm or override based on structure)
```

**Business Intent Signals block** (from `deriveIntentLayer`):
```
BUSINESS INTENT SIGNALS (pre-derived — use as context, override if flow contradicts):
- Lifecycle stage       : Onboarding / First activation
- Primary intent        : Drive conversion from free to paid
- Segmentation type     : Subscription-state split (Free vs Paid users)
- Engagement channel    : in-app messages (real-time contextual) + email
- Timing strategy       : Real-time event-triggered — immediate response to user action
- Customer problem      : New users signed up but have not discovered paid features
- Behavioral target     : First subscription purchase or plan upgrade
```

**Audience Definitions block** (from Agent 1):
```
AUDIENCE DEFINITIONS (resolved from Adobe UPS API):
  [1] "New Mobile Users"
       → Users who installed the mobile app within the last 30 days and have not yet made a purchase.
```

**Journey Flow block** (from `buildFlowPath`):
```
JOURNEY FLOW (primary signal — read this to understand the customer experience being designed):
Audience Entry: New Mobile Users [entry point]
Condition: Free vs Paid [2 branches]
   [Free User] -> In-App: Upsell Modal [in-app] -> Wait: 3 day [timing gate]
      -> Condition: Clicked CTA [2 branches]
         [Yes] -> In-App: Confirmation [in-app] -> End
         [No] -> End
   [Paid User] -> Email: Welcome Email [email] -> End
```

**Workflow Structure block** (from `buildJourneyStructure`):
```
WORKFLOW STRUCTURE:
- Total nodes:               7 | Complexity: MEDIUM
- Branch count:              2 (2 condition nodes)
- Max path depth (BFS):      5 steps
- Message touchpoints:       YES (in-app: 2, email: 1)
- Wait/timing steps:         YES (1)
- Audience qualification:    YES
- Named audience segments:   New Mobile Users
- Personalized segmentation: YES
- Has description:           no
- Empty/shell structure:     no
```

---

## 20. Scoring Output Schema

The LLM is instructed to return exactly this JSON structure:

```typescript
interface ScoringResult {
  // Journey classification
  journeyType:      "Welcome" | "Promotional" | "Transactional" | "Re-engagement" |
                    "Abandoned Cart" | "Onboarding" | "Retention" | "Test/POC" | "Unknown";
  lifecycleStage:   "Acquisition" | "Onboarding" | "Activation" | "Retention" |
                    "Re-engagement" | "Monetization" | "Post-purchase" | "Loyalty" | "Unknown";

  // Business context (human-readable sentences)
  customerExperience: string;   // What experience is created for the customer? (1 sentence, customer POV)
  behaviorTargeted:   string;   // What user action/behavior is the workflow trying to trigger?
  businessObjective:  string;   // What measurable business outcome does this workflow achieve?
  whyTeamBuiltThis:   string;   // Strategic reasoning: why a team would build exactly this
  useCaseSummary:     string;   // Concise synthesis of flow + channels + audience + timing
  targetAudience:     string;   // Who is targeted — from segments, conditions, entry qualification
  businessPurpose:    string;   // One sentence: the strategic business process this journey serves

  // Business value assessment
  businessValue: "low" | "medium" | "high";

  // Retirement scoring (0–100, higher = more likely to retire)
  retirementScore: number;      // 0–100
  retirementLabel: "Safe to Retire" | "Review First" | "Keep Active";
  confidence:      number;      // 0–100 (LLM's own confidence in its assessment)

  // Governance fields
  reasoning:                 string;  // 2–3 sentences citing specific signals
  lifecycleDecision:         "Keep" | "Archive" | "Review";
  governanceReviewPriority:  "low" | "medium" | "high";
  recommendation:            "Archive" | "Review with owner" | "Keep" | "Contact owner before deleting";
}
```

The response also includes proxy-added fields not from the LLM:
```typescript
{
  journeyId:   string;   // Echo of the request journey.id
  model:       string;   // Ollama model name used
  _raw:        string;   // First 200 chars of raw LLM response (for debugging)
  _tokens:     { prompt: number, completion: number, total: number };
  _audiences:  Array<{ id, name, plainEnglish, status }>;
}
```

---

## 21. Configuration & Environment Variables

**File**: `ai-proxy/.env` (copy from `.env.example`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | AI proxy HTTP port |
| `OLLAMA_BASE` | `http://localhost:11434` | Ollama API base URL |
| `MODEL` | `llama3` | Ollama model name |
| `CONCURRENCY` | `1` | Max concurrent Ollama requests (semaphore limit) |
| `LOG_LEVEL` | `info` | Log verbosity: `debug` / `info` / `warn` / `error` |
| `LOG_FILE` | (unset) | Optional path to write JSON-lines log file |
| `ALLOWED_ORIGINS` | (unset) | Extra comma-separated CORS origins |
| `LLM_LOG_DIR` | (unset) | Directory for per-journey `.log` files |
| `ADOBE_TOKEN` | (unset) | Adobe IMS Bearer token (fallback for audience resolution) |
| `ADOBE_API_KEY` | (unset) | Adobe API key |
| `ADOBE_ORG_ID` | (unset) | Adobe IMS Org ID |
| `ADOBE_SANDBOX` | (unset) | Adobe sandbox name |
| `ADOBE_UPS_BASE` | `https://platform.adobe.io/data/core/ups` | UPS API base URL |

**Browser settings** (stored in `localStorage["jcc_ai"]`):

| Key | Default | Description |
|---|---|---|
| `enabled` | `false` | Whether AI scoring is enabled |
| `proxyUrl` | `http://localhost:3001` | AI proxy URL |

---

## 22. Security Model

### 22.1 Credential Isolation

| Credential | Storage | Lifetime | Who Uses It |
|---|---|---|---|
| AJO Bearer token | `sessionStorage["jcc_cfg"]` | Tab session | Browser → AJO API |
| AJO API Key | `sessionStorage["jcc_cfg"]` | Tab session | Browser → AJO API |
| IMS Org ID | `sessionStorage["jcc_cfg"]` | Tab session | Browser → AJO API |
| Tenant ID | `sessionStorage["jcc_cfg"]` | Tab session | Deep-link URL generation only |
| Adobe UPS credentials | `.env` on server | Server lifetime | Proxy → Adobe UPS API |

AJO credentials in the browser are **never sent to the AI proxy**. The proxy calls the Adobe UPS API using its own server-side credentials from `.env`. This means:
- Scorings do NOT require sharing AJO tokens with the proxy
- UPS credentials (for audience resolution) are safely on the server

### 22.2 CORS Defense

The proxy's CORS policy explicitly blocks non-allowlisted origins. Requests from arbitrary web pages cannot reach the proxy.

### 22.3 Data Privacy

Journey data sent to `POST /score` goes from browser → local AI proxy → local Ollama. Journey data **never leaves the local machine** — no cloud LLM API calls.

### 22.4 Input Validation

- All routes validate required fields and return `400` with clear messages
- Journey body is limited to 2 MB (Express JSON body limit)
- Batch endpoint caps at 10 journeys per request

---

## 23. Error Handling & Resilience

### 23.1 Error Matrix

| Error Scenario | Detection | Behavior |
|---|---|---|
| Ollama offline at startup | 15s polling interval | `/health` returns 503; `/score` returns 503 |
| Ollama goes offline mid-run | Polling detects → `ollamaOnline = false` | Next score request returns 503 |
| LLM timeout (>120s) | `AbortController` fires | Returns 504; pool records `error: "LLM timed out"` |
| LLM returns non-JSON | `extractJson()` returns null | Returns 422 with `fallback: true`; pool records error |
| Adobe UPS API 404 | `fetchAudienceDetail()` throws | `apiStatus: 'fetch-failed'`; scoring continues without that audience |
| Adobe UPS credentials missing | `effectiveCfg()` check | Audience resolution skipped silently; scoring proceeds |
| AJO API 401 | `verifyCredentials()` throws | Dashboard shows "Update Access Token" button |
| Proxy connection refused (browser) | `fetch()` rejects | After 3 consecutive failures: proxy-down banner with Retry |
| IndexedDB unavailable | `openDb()` rejects | Cache operations silently swallowed with `try/catch` |

### 23.2 Graceful Degradation Hierarchy

```
Full AI score with audiences
  ↓ (if UPS credentials missing or UPS API fails)
AI score without audience context (still runs)
  ↓ (if Ollama offline or proxy unreachable)
Rule-based score only (instant, always available)
  ↓ (if AJO API fails)
Error banner with credential update prompt
```

### 23.3 Proxy Retry Logic

The "Retry AI" button in the proxy-down banner:
1. Re-tests `GET /health`
2. If OK: filters `pendingAiTargets` to journeys without a successful LLM score
3. Calls `startAI(remaining)` — does not re-score already-successful journeys

---

## 24. Performance Characteristics

### 24.1 Throughput Estimates

| Phase | Typical Performance |
|---|---|
| AJO API fetch (50 journeys/page) | ~500ms per page |
| Rule scoring (all journeys) | Instant (browser JS) |
| Ollama LLM scoring (llama3, per journey) | 30–90s on CPU; 5–15s on GPU |
| Adobe UPS audience fetch | ~300–800ms per audience |
| Audience LLM plain-English | Same as journey scoring |
| IndexedDB save | <100ms |

### 24.2 Agent Pool Throughput (4 workers)

With 4 concurrent workers and 30s average per journey:
- 100 journeys → ~12.5 minutes on CPU (4 parallel × 30s avg × 25 batches)
- 100 journeys → ~2.5 minutes on GPU (4 parallel × 6s avg × 25 batches)

### 24.3 Token Usage (llama3, typical scoring)

| Component | Typical Tokens |
|---|---|
| Scoring prompt (Agent 2) | 1,200–1,800 prompt tokens |
| Scoring response (Agent 2) | 350–500 completion tokens |
| Audience plain-English prompt (Agent 1) | 400–600 prompt tokens |
| Audience plain-English response (Agent 1) | 30–80 completion tokens |
| **Per journey total** | **~2,000–3,000 tokens** |
| **100 journeys total** | **~200,000–300,000 tokens** |

Token usage is tracked in `GET /stats` and displayed in the dashboard progress bar after the AI run completes.

### 24.4 Cache Impact

- **First analysis**: Full fetch + rule scoring + LLM scoring = 5–30 minutes
- **Subsequent loads (within 90 days)**: IndexedDB read = <100ms, render = <50ms
- **Cache size**: ~500KB–2MB per sandbox (depends on journey count and LLM response verbosity)

### 24.5 Memory & Concurrency Notes

- The `detailCache` Map in the agent pool prevents redundant AJO detail API calls (keyed by journey ID)
- The proxy's `acquireSlot`/`releaseSlot` semaphore ensures the Ollama process is never overwhelmed
- Batch endpoint processes strictly sequentially (no parallel Ollama calls from batch) — useful for scripts/automation where response order must match input order

---

*End of Solution Design Document*

*Generated from codebase analysis of:*
- `ai-proxy/server.js`
- `ai-proxy/agents/audience-agent.js`
- `ai-proxy/agents/scoring-agent.js`
- `ai-proxy/lib/journey-analyzer.js`
- `ai-proxy/lib/expression-parser.js`
- `ai-proxy/lib/queue.js`
- `ai-proxy/lib/logger.js`
- `blocks/journey-cleanup-card/journey-cleanup-card.js`
- `blocks/journey-cleanup-card/jcc-ai-core.js`
- `blocks/journey-cleanup-card/jcc-cache.js`
