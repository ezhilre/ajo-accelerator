# Quick Start Guide - Switching LLM Providers

## Switch to Azure OpenAI (from Ollama)

1. **Create/Edit your .env file:**
```bash
cd ai-proxy
cp .env.example .env  # if you don't have .env yet
```

2. **Update .env with Azure settings:**
```env
LLM_PROVIDER=azure

AZURE_OPENAI_ENDPOINT=https://camp-azr21431-iw2kj.openai.azure.com
AZURE_OPENAI_API_KEY=your-actual-api-key-here
AZURE_OPENAI_DEPLOYMENT=gpt-5-nano-deployment-4ba7b
AZURE_OPENAI_API_VERSION=2024-02-15-preview
AZURE_OPENAI_MAX_COMPLETION_TOKENS=4000
```

> **Note**: `AZURE_OPENAI_MAX_COMPLETION_TOKENS` controls response length. Default (4000) works for most journeys. Increase to 6000-8000 for very complex journeys if you see incomplete responses.

3. **Start the server:**
```bash
node server.js
```

You should see:
```
🤖  AJO AI Proxy  started
LLM Provider: Azure OpenAI ☁️
```

4. **Test it:**
```bash
curl http://localhost:3001/health
```

Expected response:
```json
{
  "status": "ok",
  "provider": "azure",
  "model": "gpt-5-nano-deployment-4ba7b",
  "backend": "https://camp-azr21431-iw2kj.openai.azure.com",
  ...
}
```

## Switch Back to Ollama

1. **Edit .env:**
```env
LLM_PROVIDER=ollama

OLLAMA_BASE=http://localhost:11434
MODEL=llama3
```

2. **Make sure Ollama is running:**
```bash
ollama serve
```

3. **Restart the server:**
```bash
node server.js
```

You should see:
```
🤖  AJO AI Proxy  started
LLM Provider: Ollama 🦙
```

## That's It!

- ✅ No code changes needed
- ✅ Just edit `.env` and restart
- ✅ Frontend works with both providers automatically
- ✅ All existing endpoints work the same way

For more details, see [LLM_PROVIDER_CONFIG.md](./LLM_PROVIDER_CONFIG.md)
