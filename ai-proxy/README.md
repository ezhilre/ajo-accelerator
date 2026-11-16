# AJO AI Proxy

Local Node.js proxy that bridges the EDS Journey Cleanup Dashboard to LLM providers: **Ollama (local)** or **Azure OpenAI (cloud)**.

> **✨ New:** Multi-provider support! Switch between local Ollama and Azure OpenAI with a simple configuration change. See [LLM_PROVIDER_CONFIG.md](./LLM_PROVIDER_CONFIG.md) for details.

## Prerequisites

1. **Node.js 18+** — already installed
2. **LLM Provider** — choose one:
   - **Ollama (local)** — [install from ollama.ai](https://ollama.ai)
   - **Azure OpenAI (cloud)** — requires Azure subscription with OpenAI service

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

## Configuration

Create a `.env` file from the example:
```bash
cp .env.example .env
```

Then set your LLM provider:

### Option 1: Local Ollama (Default)
```env
LLM_PROVIDER=ollama
OLLAMA_BASE=http://localhost:11434
MODEL=llama3
```

### Option 2: Azure OpenAI
```env
LLM_PROVIDER=azure
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-api-key
AZURE_OPENAI_DEPLOYMENT=gpt-4-deployment-name
AZURE_OPENAI_API_VERSION=2024-02-15-preview
```

📖 **For complete configuration guide**, see [LLM_PROVIDER_CONFIG.md](./LLM_PROVIDER_CONFIG.md)

## API Endpoints

### `GET /health`
Check if proxy and LLM provider are running.
```json
{
  "status": "ok",
  "provider": "ollama",
  "model": "llama3",
  "backend": "http://localhost:11434",
  "availableModels": ["llama3:latest", "phi3:latest"]
}
```

Or with Azure:
```json
{
  "status": "ok",
  "provider": "azure",
  "model": "gpt-4-deployment-name",
  "backend": "https://your-resource.openai.azure.com"
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

## Switching Between Providers

No code changes needed! Just update your `.env` file:

1. Stop the server (Ctrl+C)
2. Edit `.env` and change `LLM_PROVIDER=azure` or `LLM_PROVIDER=ollama`
3. Restart: `node server.js`

The proxy automatically routes requests to the configured provider.

## Architecture

```
Frontend (Browser)
    ↓
AI Proxy Server (localhost:3001)
    ↓
    ├── Ollama (http://localhost:11434)
    └── Azure OpenAI (https://your-resource.openai.azure.com)
```

The proxy runs locally regardless of which LLM provider you choose, keeping:
- API keys secure (server-side only)
- CORS handling consistent  
- Frontend code unchanged

## Troubleshooting

See [LLM_PROVIDER_CONFIG.md](./LLM_PROVIDER_CONFIG.md) for detailed troubleshooting steps.

**Quick checks:**
- Ollama: Is `ollama serve` running? Try `ollama list` to see available models
- Azure: Check your endpoint URL and API key in Azure Portal
- Both: Check server logs for detailed error messages
