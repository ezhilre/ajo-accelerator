/**
 * Azure OpenAI Service for Journey AI Scoring
 * Uses environment variables for configuration
 */

class AzureAIService {
  constructor() {
    this.endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    this.apiKey = process.env.AZURE_OPENAI_API_KEY;
    this.deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4';
    this.apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview';
    
    if (!this.endpoint || !this.apiKey) {
      console.warn('Azure OpenAI credentials not configured - AI scoring will be disabled');
    }
  }

  isConfigured() {
    return !!(this.endpoint && this.apiKey && this.deployment);
  }

  async scoreJourney(journey) {
    if (!this.isConfigured()) {
      throw new Error('Azure OpenAI not configured. Please set environment variables.');
    }

    const url = `${this.endpoint}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.apiKey
        },
        body: JSON.stringify({
          messages: this.buildScoringPrompt(journey),
          temperature: 0.3,
          max_tokens: 1500,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Azure OpenAI API error ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      const content = data.choices[0].message.content;
      return JSON.parse(content);
    } catch (error) {
      console.error('Azure OpenAI scoring failed:', error);
      throw error;
    }
  }

  async resolveAudiences(audiences, ajoConfig) {
    if (!this.isConfigured() || !audiences || !audiences.length) {
      return audiences;
    }

    const url = `${this.endpoint}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.apiKey
        },
        body: JSON.stringify({
          messages: this.buildAudiencePrompt(audiences),
          temperature: 0.2,
          max_tokens: 800,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        return audiences; // Fallback to raw audiences on error
      }

      const data = await response.json();
      const result = JSON.parse(data.choices[0].message.content);
      return result.audiences || audiences;
    } catch (error) {
      console.warn('Audience resolution failed:', error);
      return audiences; // Graceful fallback
    }
  }

  buildScoringPrompt(journey) {
    return [
      {
        role: 'system',
        content: `You are an expert Adobe Journey Optimizer analyst. Analyze journeys and provide structured retirement risk assessments in JSON format. Consider business value, lifecycle stage, and customer impact.`
      },
      {
        role: 'user',
        content: `Analyze this AJO journey and return a JSON object with the following structure:

{
  "retirementScore": <number 0-100>,
  "retirementLabel": "<one of: Safe to Delete | Review First | Keep Active>",
  "businessValue": "<one of: low | medium | high>",
  "journeyType": "<one of: Welcome | Promotional | Transactional | Re-engagement | Abandoned Cart | Onboarding | Retention | Test/POC | Unknown>",
  "lifecycleStage": "<one of: Acquisition | Onboarding | Activation | Retention | Re-engagement | Monetization | Post-purchase | Loyalty | Unknown>",
  "useCaseSummary": "<brief 1-2 sentence description of what this journey does>",
  "targetAudience": "<who this journey targets>",
  "customerExperience": "<what customers experience in this journey>",
  "behaviorTargeted": "<specific customer behaviors this addresses>",
  "businessObjective": "<business goal this journey serves>",
  "whyTeamBuiltThis": "<inferred original purpose>",
  "reasoning": "<explain why you assigned this retirement score>",
  "recommendation": "<clear action: Keep | Review | Archive>",
  "confidence": <number 0-100>
}

Journey Data:
- Name: ${journey.name}
- Status: ${journey.status}
- Version: ${journey.version || 1}
- Created: ${journey.metadata?.createdAt || 'Unknown'}
- Last Modified: ${journey.metadata?.lastModifiedAt || 'Unknown'}
- Days Since Last Modified: ${journey._daysStale || 0}
- Is Default Name (never renamed): ${journey._isDefaultName || false}
- Created By: ${journey.metadata?.createdBy || 'Unknown'}
- Modified By: ${journey.metadata?.lastModifiedBy || 'Unknown'}
- Audiences: ${JSON.stringify(journey.audiences || [])}
- Description: ${journey.description || 'None'}

Important Guidelines:
- High retirement scores (80+) = Safe to delete (stale, test, or deprecated)
- Medium scores (50-79) = Review first (unclear if still needed)
- Low scores (0-49) = Keep active (valuable business journey)
- Consider staleness, naming patterns, and business indicators
- Default names suggest test/poc journeys
- Active status + recent changes = lower retirement score`
      }
    ];
  }

  buildAudiencePrompt(audiences) {
    return [
      {
        role: 'system',
        content: `You are an audience analysis expert. Convert technical audience IDs/names into plain English descriptions.`
      },
      {
        role: 'user',
        content: `Convert these audience identifiers to plain English descriptions. Return JSON:

{
  "audiences": [
    {
      "id": "<original id>",
      "name": "<original name>",
      "plainEnglish": "<human-readable description>"
    }
  ]
}

Audiences: ${JSON.stringify(audiences)}`
      }
    ];
  }

  async testConnection() {
    if (!this.isConfigured()) {
      return { ok: false, error: 'Azure OpenAI not configured' };
    }

    try {
      const testJourney = {
        name: 'Test Journey',
        status: 'draft',
        version: 1,
        metadata: {
          createdAt: new Date().toISOString(),
          lastModifiedAt: new Date().toISOString()
        },
        _daysStale: 0,
        _isDefaultName: false
      };

      await this.scoreJourney(testJourney);
      return { ok: true, model: this.deployment };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}

export default new AzureAIService();
