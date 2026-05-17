# AJO AI Proxy

Local Node.js proxy that bridges the EDS Journey Cleanup Dashboard to Ollama (phase 1) or any cloud LLM (phase 2).

## Prerequisites

1. **Node.js 18+** — already installed
2. **Ollama** — [install from ollama.ai](https://ollama.ai)

## Setup (one-time)

```bash
# 1. Install Ollama (macOS)
brew install ollama

# 2. Pull a model (llama3 is ~4GB, fast enough for this task)
ollama pull llama3

# Or use a smaller/faster model:
# ollama pull phi3          (~2GB, very fast)
# ollama pull mistral       (~4GB, good quality)
# ollama pull gemma2:2b     (~1.5GB, fastest)

# 3. Install proxy dependencies
cd ai-proxy
npm install
```

## Running

```bash
# Terminal 1 — Ollama (if not running as a service)
ollama serve

# Terminal 2 — AJO AI Proxy
cd ai-proxy
node server.js
# → 🤖 AJO AI Proxy  →  http://localhost:3001

# Terminal 3 — EDS dev server (as usual)
cd ..
aem up
```

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Port to listen on |
| `OLLAMA_BASE` | `http://localhost:11434` | Ollama base URL |
| `MODEL` | `llama3` | Model name to use |
| `CONCURRENCY` | `1` | Max parallel LLM calls (keep at 1 for Ollama) |

Example:
```bash
MODEL=phi3 PORT=3001 node server.js
```

## API Endpoints

### `GET /health`
Check if proxy and Ollama are running.
```json
{
  "status": "ok",
  "model": "llama3",
  "ollama": "connected",
  "availableModels": ["llama3:latest", "phi3:latest"]
}
```

### `POST /score`
Score a single journey.
```json
Request:  { "journey": { ...full journey object with _daysStale, _isDefaultName } }
Response: { "journeyId": "...", "retirementScore": 85, "retirementLabel": "Safe to Retire", ... }
```

### `POST /score/batch`
Score up to 10 journeys at once.
```json
Request:  { "journeys": [...array of journey objects] }
Response: { "results": [...score objects] }
```

## Phase 2 — Switching to a Cloud Model

Change 2 lines in `server.js`:

```javascript
// Replace callOllama() with your cloud provider:

// Claude (Anthropic)
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
async function callLLM(prompt) {
  const msg = await client.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content[0].text;
}

// OpenAI
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
async function callLLM(prompt) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
  });
  return res.choices[0].message.content;
}
```

Then deploy `server.js` to AWS Lambda / Cloud Run / Render and update the proxy URL in the dashboard settings.

## Deploying to AWS Lambda (Phase 2)

```bash
# Using AWS SAM or serverless framework
# The server.js logic can be wrapped in a Lambda handler in ~10 lines
# See: https://github.com/vendia/serverless-express
