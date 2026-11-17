/*
 * Fetch Delivery Report Action
 * Server-side action to fetch campaigns and journeys with channel details
 * Handles 100+ API calls with proper timeout management
 */

const fetch = require('node-fetch');
const { Core } = require('@adobe/aio-sdk');
const { errorResponse, checkMissingRequestInputs } = require('../utils');

// Azure OpenAI configuration (from environment)
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview';
const AZURE_OPENAI_MAX_TOKENS = parseInt(process.env.AZURE_OPENAI_MAX_TOKENS || '4000');

// Adobe AJO configuration (from environment)
const ADOBE_ORG_ID = process.env.ADOBE_ORG_ID;
const ADOBE_TENANT_ID = process.env.ADOBE_TENANT_ID;

// Sandbox-specific API Keys
const ADOBE_API_KEY_XLG_DEV = process.env.ADOBE_API_KEY_XLG_DEV;
const ADOBE_API_KEY_XLG_STAGE = process.env.ADOBE_API_KEY_XLG_STAGE;
const ADOBE_API_KEY_XLG_PROD = process.env.ADOBE_API_KEY_XLG_PROD;

// AJO API endpoints
const CAMPAIGN_GQL_URL = 'https://exc-unifiedcontent.experience.adobe.net/api/gql/app/ajoCampaignsApp/graphql?appId=ajoCampaignsApp';
const JOURNEY_GQL_URL = 'https://exc-unifiedcontent.experience.adobe.net/api/gql/app/cjm-journeys-next-admin/graphql?appId=cjm-journeys-next-admin';
const JOURNEY_DETAIL_URL = 'https://platform.adobe.io/ajo/journey';

// Channel label mapping (matches EDS logic)
const JOURNEY_CHANNEL_LABELS = [
  ['push notification', 'Push notification'],
  ['in-app message', 'In-app message'],
  ['code-based experience', 'Code-based experience'],
  ['mobile message', 'Mobile message'],
  ['content card', 'Content Card'],
  ['whatsapp', 'WhatsApp'],
  ['email', 'Email'],
  ['web', 'Web'],
  ['line', 'LINE'],
];

/**
 * Fetch campaigns for a date range via GraphQL
 */
async function fetchCampaigns(credentials, startMs, endMs, logger) {
  const query = `
    query searchV2($params: GlobalSearchRequestParams) {
      globalSearch(params: $params) {
        metrics { total_hits }
        result_sets {
          data {
            id name labels description created createdby modified modifiedby custom
            tags { id name tagCategoryId tagCategoryName }
          }
        }
      }
    }
  `;

  const body = {
    operationName: 'searchV2',
    query,
    variables: {
      params: {
        isPostNounFilter: false,
        q: '',
        limit: 500,
        start_index: 0,
        sort_orderby: 'modified',
        filters: {
          standard: {
            filterList: [
              { filterName: 'noun', filterType: 'enum_values', anyOf: ['campaign'] },
              { filterName: 'sandboxname', filterType: 'enum_values', anyOf: [credentials.sandbox] },
            ],
          },
          custom: [{
            filterList: [
              { filterName: 'status', filterType: 'enum_values', anyOf: ['SCHEDULED', 'LIVE', 'IN_REVIEW', 'STOPPED', 'COMPLETED', 'FAILED', 'ARCHIVED'] },
              { filterName: 'trueStartDate', filterType: 'datetime', max: String(endMs) },
              { filterName: 'trueEndDate', filterType: 'datetime', min: String(startMs) },
              { filterName: 'status', filterType: 'enum_values', anyOf: ['COMPLETED', 'STOPPED', 'LIVE'] },
            ],
            noun: 'campaign',
          }],
        },
      },
    },
    sandboxName: credentials.sandbox,
  };

  const res = await fetch(CAMPAIGN_GQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${credentials.token}`,
      'x-api-key': 'exc_app',
      'x-gw-ims-org-id': credentials.orgId,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Campaign fetch failed: HTTP ${res.status} - ${text.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Fetch journeys for a date range via GraphQL
 */
async function fetchJourneys(credentials, startMs, endMs, logger) {
  const query = `
    query searchV2($params: GlobalSearchRequestParams) {
      globalSearch(params: $params) {
        metrics { total_hits }
        result_sets {
          data {
            id name labels description created createdby modified modifiedby custom
            tags { id name tagCategoryId tagCategoryName }
          }
        }
      }
    }
  `;

  const body = {
    operationName: 'searchV2',
    query,
    variables: {
      params: {
        isPostNounFilter: false,
        limit: 500,
        start_index: 0,
        sort_orderby: 'modified',
        filters: {
          standard: {
            filterList: [
              { filterName: 'noun', filterType: 'enum_values', anyOf: ['journey'] },
              { filterName: 'sandboxname', filterType: 'enum_values', anyOf: [credentials.sandbox] },
            ],
          },
          custom: [{
            filterList: [
              { filterName: 'startDate', filterType: 'datetime', max: String(endMs) },
              { filterName: 'endDateTimeline', filterType: 'datetime', min: String(startMs) },
              { filterName: 'state', filterType: 'enum_values', anyOf: ['deployed', 'redeployed', 'finishedEmpty', 'stopped'] },
            ],
            noun: 'journey',
          }],
        },
      },
    },
    sandboxName: credentials.sandbox,
  };

  const res = await fetch(JOURNEY_GQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${credentials.token}`,
      'x-api-key': 'exc_app',
      'x-gw-ims-org-id': credentials.orgId,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Journey fetch failed: HTTP ${res.status} - ${text.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Get the appropriate API key for the given sandbox
 */
function getApiKeyForSandbox(sandbox) {
  const apiKeys = {
    'xlg-dev': ADOBE_API_KEY_XLG_DEV,
    'xlg-stage': ADOBE_API_KEY_XLG_STAGE,
    'xlg-prod': ADOBE_API_KEY_XLG_PROD,
  };
  return apiKeys[sandbox];
}

/**
 * Fetch journey detail to extract channels from campaign nodes
 */
async function fetchJourneyDetail(credentials, journeyId, logger) {
  const url = `${JOURNEY_DETAIL_URL}/${journeyId}`;
  
  // Get sandbox-specific API key
  const apiKey = getApiKeyForSandbox(credentials.sandbox);
  
  if (!apiKey) {
    logger.error(`Adobe API Key not configured for sandbox: ${credentials.sandbox}`);
    return null;
  }
  
  logger.info(`Fetching journey detail for ${journeyId}`);
  logger.info(`Using API Key for ${credentials.sandbox}: ${apiKey.substring(0, 8)}...`);
  logger.info(`Org ID: ${credentials.orgId}`);
  
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${credentials.token}`,
      'x-api-key': apiKey,
      'x-gw-ims-org-id': credentials.orgId,
      'x-sandbox-name': credentials.sandbox,
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    logger.warn(`Journey detail fetch failed for ${journeyId}: HTTP ${res.status} - ${errorText.slice(0, 200)}`);
    // Don't throw on 404 - journey might be deleted
    if (res.status === 404) return null;
    return null; // Return null on other errors too, don't break the flow
  }

  const data = await res.json();
  logger.info(`Successfully fetched journey detail for ${journeyId}`);
  return data;
}

/**
 * Extract channels from journey detail (campaign nodes)
 */
function extractChannelsFromDetail(detail) {
  if (!detail || !detail.nodes) return [];
  
  const found = new Set();
  detail.nodes.forEach((node) => {
    if (node.type !== 'campaign') return;
    const nameLower = (node.name || '').toLowerCase();

    // Rule 1: case-insensitive starts-with
    let matched = false;
    for (const [prefix, label] of JOURNEY_CHANNEL_LABELS) {
      if (nameLower.startsWith(prefix)) {
        found.add(label);
        matched = true;
        break;
      }
    }

    // Rule 2: fallback contains
    if (!matched) {
      for (const [prefix, label] of JOURNEY_CHANNEL_LABELS) {
        if (nameLower.includes(prefix)) {
          found.add(label);
        }
      }
    }
  });
  
  return [...found];
}

/**
 * Process campaigns from API response
 */
function processCampaigns(campaignResp, logger) {
  const resultSets = campaignResp?.data?.globalSearch?.result_sets || [];
  
  return resultSets
    .filter(rs => rs && rs.data)
    .map(rs => {
      const item = rs.data;
      let custom = item.custom;
      if (typeof custom === 'string') {
        try {
          custom = JSON.parse(custom);
        } catch (e) {
          logger.warn(`Failed to parse custom field for campaign ${item.id}`);
          custom = {};
        }
      }
      
      return {
        _type: 'campaign',
        campaignId: item.id,
        versionId: custom?.versions?.[0]?.id || item.id,
        name: item.name || 'Unnamed Campaign',
        description: item.description || '',
        status: custom?.versions?.[0]?.executionStatus || custom?.status || 'Unknown',
        createdBy: item.createdby,
        createdByName: custom?.createdByName || item.createdby,
        publishedAt: custom?.versions?.[0]?.publishedAt || item.created,
        modifiedAt: item.modified,
        tags: item.tags || [],
        packages: custom?.versions?.[0]?.packages || [],
      };
    });
}

/**
 * Process journeys from API response (without channels yet)
 */
function processJourneys(journeyResp, logger) {
  const resultSets = journeyResp?.data?.globalSearch?.result_sets || [];
  
  return resultSets
    .filter(rs => rs && rs.data)
    .map(rs => {
      const item = rs.data;
      let custom = item.custom;
      if (typeof custom === 'string') {
        try {
          custom = JSON.parse(custom);
        } catch (e) {
          logger.warn(`Failed to parse custom field for journey ${item.id}`);
          custom = {};
        }
      }
      
      // Skip Dry Run journeys
      const displayState = (custom?.displayState || '').toLowerCase();
      if (displayState === 'dryrun' || displayState === 'dry_run' || displayState === 'dry run') {
        return null;
      }
      
      return {
        _type: 'journey',
        campaignId: item.id,
        name: item.name || 'Unnamed Journey',
        description: item.description || '',
        status: custom?.state || custom?.displayState || 'Unknown',
        createdBy: item.createdby,
        createdByName: custom?.createdByName || item.createdby,
        publishedAt: custom?.startDate || item.created,
        modifiedAt: item.modified,
        tags: item.tags || [],
        _channels: '', // Will be filled by detail fetch
      };
    })
    .filter(j => j !== null);
}

/**
 * Generate AI summary using Azure OpenAI (EDS-style prompt)
 */
async function generateAISummary(item, logger) {
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY) {
    logger.warn('Azure OpenAI not configured - skipping AI summary');
    return null;
  }

  const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
  
  const prompt = buildScoringPrompt(item);
  
  try {
    const requestBody = {
      messages: prompt,
      max_completion_tokens: AZURE_OPENAI_MAX_TOKENS,
      response_format: { type: 'json_object' },
    };
    
    logger.info(`Generating AI summary for: ${item.name}`);
    logger.info(`Azure OpenAI URL: ${url}`);
    logger.info(`API Key present: ${!!AZURE_OPENAI_API_KEY}`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_API_KEY,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`AI summary failed for ${item.name}:`);
      logger.error(`HTTP Status: ${response.status}`);
      logger.error(`Error response: ${errorText.slice(0, 500)}`);
      return null;
    }

    const data = await response.json();
    const content = data.choices[0].message.content;
    logger.info(`Successfully generated AI summary for ${item.name}`);
    return JSON.parse(content);
  } catch (error) {
    logger.error(`AI summary exception for ${item.name}:`, error.message);
    logger.error(`Error stack:`, error.stack);
    return null;
  }
}

/**
 * Build EDS-style scoring prompt (matches azureAIService.js)
 */
function buildScoringPrompt(item) {
  const daysStale = item.modifiedAt 
    ? Math.floor((Date.now() - Number(item.modifiedAt)) / 86400000) 
    : 0;

  return [
    {
      role: 'system',
      content: `You are an expert Adobe Journey Optimizer analyst. Analyze campaigns/journeys and provide structured assessments in JSON format. Consider business value, lifecycle stage, and customer impact.`,
    },
    {
      role: 'user',
      content: `Analyze this AJO ${item._type} and return a JSON object with the following structure:

{
  "retirementScore": <number 0-100>,
  "retirementLabel": "<one of: Safe to Delete | Review First | Keep Active>",
  "businessValue": "<one of: low | medium | high>",
  "journeyType": "<one of: Welcome | Promotional | Transactional | Re-engagement | Abandoned Cart | Onboarding | Retention | Test/POC | Unknown>",
  "lifecycleStage": "<one of: Acquisition | Onboarding | Activation | Retention | Re-engagement | Monetization | Post-purchase | Loyalty | Unknown>",
  "useCaseSummary": "<brief 1-2 sentence description of what this ${item._type} does>",
  "targetAudience": "<who this ${item._type} targets>",
  "customerExperience": "<what customers experience in this ${item._type}>",
  "behaviorTargeted": "<specific customer behaviors this addresses>",
  "businessObjective": "<business goal this ${item._type} serves>",
  "whyTeamBuiltThis": "<inferred original purpose>",
  "reasoning": "<explain the business context and value>",
  "recommendation": "<clear action: Keep | Review | Archive>",
  "confidence": <number 0-100>
}

${item._type === 'campaign' ? 'Campaign' : 'Journey'} Data:
- Name: ${item.name}
- Status: ${item.status}
- Created: ${item.publishedAt || 'Unknown'}
- Last Modified: ${item.modifiedAt || 'Unknown'}
- Days Since Last Modified: ${daysStale}
- Created By: ${item.createdByName || item.createdBy || 'Unknown'}
- Tags: ${JSON.stringify(item.tags || [])}
- Channels: ${item._channels || (item.packages ? item.packages.map(p => p.channel).join(', ') : 'Unknown')}
- Description: ${item.description || 'None'}

Important Guidelines:
- Focus on business value and customer impact
- Identify the journey/campaign type and lifecycle stage
- Provide actionable insights for marketing teams
- Consider staleness but prioritize business value
- Keep useCaseSummary concise (1-2 sentences)`,
    },
  ];
}

/**
 * Main action handler
 */
async function main(params) {
  const logger = Core.Logger('fetch-delivery-report', { level: params.LOG_LEVEL || 'info' });

  try {
    logger.info('Fetch Delivery Report action invoked');

    // Extract IMS token from Authorization header
    // OpenWhisk normalizes headers to lowercase
    const headers = params.__ow_headers || {};
    logger.info('Available headers:', Object.keys(headers));
    
    const authHeader = headers.authorization || headers.Authorization || '';
    logger.info('Auth header present:', !!authHeader);
    
    const token = authHeader.replace(/^Bearer\s+/i, '');
    
    if (!token) {
      logger.error('No token found in headers');
      return errorResponse(401, 'Missing authorization token in request headers', logger);
    }
    
    logger.info('Token extracted successfully, length:', token.length);

    // Validate environment variables
    if (!ADOBE_ORG_ID || !ADOBE_TENANT_ID) {
      return errorResponse(500, 'Adobe configuration missing in environment variables', logger);
    }

    // Validate required parameters
    const requiredParams = ['sandbox', 'year', 'month', 'type'];
    const errorMessage = checkMissingRequestInputs(params, requiredParams, []);
    if (errorMessage) {
      return errorResponse(400, errorMessage, logger);
    }

    const credentials = {
      token: token,
      orgId: ADOBE_ORG_ID,
      sandbox: params.sandbox,
    };

    const year = parseInt(params.year);
    const month = parseInt(params.month);
    const type = params.type; // 'campaign' | 'journey' | 'both'
    const includeAI = params.includeAI !== 'false'; // default true

    // Calculate date range
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    const startMs = startDate.getTime();
    const endMs = endDate.getTime();

    logger.info(`Fetching ${type} for ${year}-${month} (${params.sandbox})`);

    let campaigns = [];
    let journeys = [];

    // Fetch campaigns if needed
    if (type === 'campaign' || type === 'both') {
      logger.info('Fetching campaigns...');
      const campaignResp = await fetchCampaigns(credentials, startMs, endMs, logger);
      campaigns = processCampaigns(campaignResp, logger);
      logger.info(`Fetched ${campaigns.length} campaigns`);
    }

    // Fetch journeys if needed
    if (type === 'journey' || type === 'both') {
      logger.info('Fetching journeys...');
      const journeyResp = await fetchJourneys(credentials, startMs, endMs, logger);
      journeys = processJourneys(journeyResp, logger);
      logger.info(`Fetched ${journeys.length} journeys`);

      // Fetch journey details in batches to get channels
      if (journeys.length > 0) {
        logger.info(`Fetching channel details for ${journeys.length} journeys...`);
        const BATCH_SIZE = 5;
        let processed = 0;

        for (let i = 0; i < journeys.length; i += BATCH_SIZE) {
          const batch = journeys.slice(i, i + BATCH_SIZE);
          
          await Promise.all(batch.map(async (journey) => {
            try {
              const detail = await fetchJourneyDetail(credentials, journey.campaignId, logger);
              if (detail) {
                const channels = extractChannelsFromDetail(detail);
                journey._channels = channels.join(', ');
              }
            } catch (error) {
              logger.warn(`Failed to fetch detail for journey ${journey.campaignId}: ${error.message}`);
              // Keep empty channels on error
            }
            processed++;
          }));

          logger.info(`Processed ${processed}/${journeys.length} journey details`);
        }
      }
    }

    // Combine and sort
    const combined = [...campaigns, ...journeys].sort((a, b) => 
      Number(b.modifiedAt) - Number(a.modifiedAt)
    );

    // Generate AI summaries if enabled
    let aiSummaries = {};
    if (includeAI && AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_API_KEY) {
      logger.info(`Generating AI summaries for ${combined.length} items...`);
      const BATCH_SIZE = 5;
      let processed = 0;

      for (let i = 0; i < combined.length; i += BATCH_SIZE) {
        const batch = combined.slice(i, i + BATCH_SIZE);
        
        await Promise.all(batch.map(async (item) => {
          try {
            const aiResult = await generateAISummary(item, logger);
            if (aiResult) {
              aiSummaries[item.campaignId] = aiResult;
              // Attach AI data to item for easy access
              item.aiSummary = aiResult;
            }
          } catch (error) {
            logger.warn(`Failed to generate AI summary for ${item.campaignId}: ${error.message}`);
          }
          processed++;
        }));

        logger.info(`Generated AI summaries: ${processed}/${combined.length}`);
      }
      
      logger.info(`AI summary generation complete: ${Object.keys(aiSummaries).length}/${combined.length} succeeded`);
    } else if (!includeAI) {
      logger.info('AI summaries disabled by request');
    } else {
      logger.warn('Azure OpenAI not configured - AI summaries skipped');
    }

    logger.info(`Returning ${combined.length} total items (${campaigns.length} campaigns, ${journeys.length} journeys)`);

    return {
      statusCode: 200,
      body: {
        campaigns,
        journeys,
        combined,
        aiSummaries, // Separate for backward compatibility
        tenantId: ADOBE_TENANT_ID, // Include tenantId for frontend URL generation
        stats: {
          totalCampaigns: campaigns.length,
          totalJourneys: journeys.length,
          total: combined.length,
          aiSummariesGenerated: Object.keys(aiSummaries).length,
        },
      },
    };

  } catch (error) {
    logger.error('Action failed:', error);
    return errorResponse(500, error.message, logger);
  }
}

exports.main = main;
