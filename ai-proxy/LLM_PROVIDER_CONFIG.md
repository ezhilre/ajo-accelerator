# LLM Provider Configuration Guide

The AI Proxy now supports multiple LLM backends: **Local Ollama** and **Azure OpenAI**.

## Quick Start

Switch between providers by setting `LLM_PROVIDER` in your `.env` file:
- `LLM_PROVIDER=ollama` → Use local Ollama (default)
- `LLM_PROVIDER=azure` → Use Azure OpenAI cloud service

## Configuration

### 1. Create Your .env File

```bash
cd ai-proxy
cp .env.example .env
```

### 2. Choose Your Provider

#### Option A: Local Ollama (Default)

```env
LLM_PROVIDER=ollama
OLLAMA_BASE=http://localhost:11434
MODEL=llama3
```

**Prerequisites:**
- Install and start Ollama: `ollama serve`
- Pull a model: `ollama pull llama3`

#### Option B: Azure OpenAI

```env
LLM_PROVIDER=azure
AZURE_OPENAI_ENDPOINT=https://camp-azr21431-iw2kj.openai.azure.com
AZURE_OPENAI_API_KEY=your-api-key-here
AZURE_OPENAI_DEPLOYMENT=gpt-5-nano-deployment-4ba7b
AZURE_OPENAI_API_VERSION=2024-02-15-preview
AZURE_OPENAI_MAX_COMPLETION_TOKENS=4000
```

**Prerequisites:**
- Active Azure OpenAI subscription
- Deployed model (e.g., GPT-4, GPT-3.5)
- Valid API key

## Testing Your Configuration

### 1. Start the Server

```bash
cd ai-proxy
npm install  # first time only
node server.js
```

You should see startup logs indicating which provider is active:
- Ollama: `LLM Provider: Ollama 🦙`
- Azure: `LLM Provider: Azure OpenAI ☁️`

### 2. Check Health Endpoint

```bash
curl http://localhost:3001/health
```

**Expected Response (Ollama):**
```json
{
  "status": "ok",
  "provider": "ollama",
  "model": "llama3",
  "backend": "http://localhost:11434",
  "availableModels": ["llama3", "..."],
  "adobeCredentials": false
}
```

**Expected Response (Azure):**
```json
{
  "status": "ok",
  "provider": "azure",
  "model": "gpt-5-nano-deployment-4ba7b",
  "backend": "https://camp-azr21431-iw2kj.openai.azure.com",
  "adobeCredentials": false
}
```

### 3. Test Scoring Endpoint

```bash
curl -X POST http://localhost:3001/score \
  -H "Content-Type: application/json" \
  -d '{
    "journey": {
      "id": "test-123",
      "name": "Test Journey",
      "status": "draft"
    }
  }'
```

## Switching Providers

To switch providers:

1. Stop the server (Ctrl+C)
2. Edit `.env` and change `LLM_PROVIDER`
3. Restart the server: `node server.js`

No code changes required!

## Architecture

```
Frontend → AI Proxy (localhost:3001) → [Ollama OR Azure]
```

The proxy server runs locally regardless of which LLM provider you choose. This keeps:
- Your Azure API key secure (server-side only)
- CORS handling consistent
- Frontend code unchanged

## Configuration Parameters

### Common Settings
- `PORT` - Proxy server port (default: 3001)
- `CONCURRENCY` - Max concurrent LLM requests (default: 1)
- `REQUEST_TIMEOUT_MS` - LLM request timeout (default: 300000 = 5min)
- `LOG_LEVEL` - Logging verbosity: debug|info|warn|error

### Ollama Settings
- `OLLAMA_BASE` - Ollama server URL
- `MODEL` - Model name (e.g., llama3, mistral, etc.)

### Azure OpenAI Settings
- `AZURE_OPENAI_ENDPOINT` - Your Azure OpenAI endpoint URL
- `AZURE_OPENAI_API_KEY` - Your API key
- `AZURE_OPENAI_DEPLOYMENT` - Your deployment name
- `AZURE_OPENAI_API_VERSION` - API version (e.g., 2024-02-15-preview)
- `AZURE_OPENAI_MAX_COMPLETION_TOKENS` - Maximum tokens for completion (default: 4000, range: 1000-16000)

## Token Configuration (Azure)

The `AZURE_OPENAI_MAX_COMPLETION_TOKENS` setting controls how many tokens the model can use for its response.

### Default: 4000 tokens

This provides a good balance for most journeys:
- **Typical usage**: ~2,700 tokens for standard journey
- **Headroom**: ~32% buffer for complex cases
- **Cost**: Reasonable for production use

### When to Adjust

**Increase to 6000-8000** if you see:
- `finish_reason: "length"` in logs
- Incomplete JSON responses
- Very complex journeys (50+ nodes, 10+ audiences)

**Decrease to 2000-3000** if:
- Testing with simple journeys
- Cost optimization is critical
- Journey complexity is consistently low

### How to Change

1. Edit `.env`:
```env
AZURE_OPENAI_MAX_COMPLETION_TOKENS=6000
```

2. Restart server:
```bash
node server.js
```

3. Monitor logs for:
```
completion_tokens: 5432  # Watch this number
finish_reason: "stop"    # Good: completed naturally
finish_reason: "length"  # Bad: hit token limit
```

### Validation

The system automatically validates the value:
- **Minimum**: 1000 tokens
- **Maximum**: 16000 tokens
- **Invalid values**: Automatically clamped to range with warning in logs

## Troubleshooting

### Provider Shows as Offline

**Ollama:**
- Ensure Ollama is running: `ollama serve`
- Check model is available: `ollama list`
- Verify OLLAMA_BASE URL is correct

**Azure:**
- Verify AZURE_OPENAI_ENDPOINT is correct
- Check API key is valid
- Ensure deployment name matches your Azure setup
- Check Azure service is not experiencing outages

### Request Timeouts

- Increase `REQUEST_TIMEOUT_MS` in .env
- For Azure: Check your token limits and rate limits
- For Ollama: Ensure your machine has sufficient resources

### API Key Issues (Azure)

- Verify the key in Azure Portal → Your OpenAI Resource → Keys and Endpoint
- Ensure the key hasn't expired
- Check you're using the correct key (Key 1 or Key 2)

## Example: Full Azure Configuration

```env
PORT=3001
LLM_PROVIDER=azure

# Azure OpenAI Settings
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=abc123def456...
AZURE_OPENAI_DEPLOYMENT=gpt-4-deployment
AZURE_OPENAI_API_VERSION=2024-02-15-preview

# Performance Settings
CONCURRENCY=2
REQUEST_TIMEOUT_MS=300000

# Logging
LOG_LEVEL=info
```

## Testing Your Azure Setup

You can test the Azure endpoint directly:

```bash
curl -X POST \
  "https://your-resource.openai.azure.com/openai/deployments/your-deployment/chat/completions?api-version=2024-02-15-preview" \
  -H "Content-Type: application/json" \
  -H "api-key: your-api-key" \
  -d '{
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'
```

## Support

For issues or questions:
1. Check the server logs for error messages
2. Verify your configuration matches this guide
3. Test the provider directly (outside the proxy) to isolate issues
