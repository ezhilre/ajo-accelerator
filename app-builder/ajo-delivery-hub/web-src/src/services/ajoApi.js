/**
 * Adobe Journey Optimizer API Service
 * Handles all AJO API calls for journeys, campaigns, and delivery data
 */

const AJO_BASE = 'https://platform.adobe.io/ajo/journey';
const AJO_CAMPAIGN_BASE = 'https://exc-unifiedcontent.experience.adobe.net/api/gql/app/ajoCampaignsApp/graphql?appId=ajoCampaignsApp';
const AJO_JOURNEY_GQL = 'https://exc-unifiedcontent.experience.adobe.net/api/gql/app/cjm-journeys-next-admin/graphql?appId=cjm-journeys-next-admin';
const PAGE_SIZE = 50;

class AJOApiService {
  /**
   * Fetch paginated journeys with filters
   */
  async fetchJourneys(config, page = 0, signal = null) {
    const today = new Date().toISOString().slice(0, 10);
    const filter = `status=draft,failed,stopped,closed,finished,live,deployed&metadata.lastModifiedAt<${today}`;
    const url = `${AJO_BASE}?pageSize=${PAGE_SIZE}&page=${page}&filter=${encodeURIComponent(filter)}`;

    const response = await fetch(url, {
      signal,
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'x-api-key': config.apiKey,
        'x-gw-ims-org-id': config.orgId,
        'x-sandbox-name': config.sandbox
      }
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`AJO API error ${response.status}: ${errorText}`);
    }

    return response.json();
  }

  /**
   * Fetch all journeys with progress callback
   */
  async fetchAllJourneys(config, onProgress, onError) {
    const allJourneys = [];
    let abortController = new AbortController();

    try {
      // Fetch first page to get total count
      const firstPage = await this.fetchJourneys(config, 0, abortController.signal);
      const items = firstPage.results || [];
      const total = firstPage.pagination?.totalCount ?? items.length;
      const totalPages = Math.ceil(total / PAGE_SIZE);

      if (items.length > 0) {
        allJourneys.push(...items);
        onProgress?.(items, [...allJourneys], 0, total);
      }

      // Fetch remaining pages
      for (let page = 1; page < totalPages; page++) {
        if (abortController.signal.aborted) break;

        const pageData = await this.fetchJourneys(config, page, abortController.signal);
        const pageItems = pageData.results || [];
        
        if (pageItems.length > 0) {
          allJourneys.push(...pageItems);
          onProgress?.(pageItems, [...allJourneys], page, total);
        }
      }

      return { journeys: allJourneys, abortController };
    } catch (error) {
      if (error.name === 'AbortError') {
        return { journeys: allJourneys, aborted: true };
      }
      onError?.(error);
      throw error;
    }
  }

  /**
   * Fetch single journey details by ID
   */
  async fetchJourneyDetail(config, journeyId) {
    const url = `${AJO_BASE}/${encodeURIComponent(journeyId)}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'x-api-key': config.apiKey,
        'x-gw-ims-org-id': config.orgId,
        'x-sandbox-name': config.sandbox
      }
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Journey detail fetch failed ${response.status}: ${errorText}`);
    }

    return response.json();
  }

  /**
   * Delete a journey by ID
   */
  async deleteJourney(config, journeyId) {
    const url = `https://journey-private.adobe.io/authoring/journeyVersions/${encodeURIComponent(journeyId)}`;
    
    // Clean token
    const rawToken = String(config.token || '').replace(/\s+/g, ' ').trim();
    const authHeader = rawToken.toLowerCase().startsWith('bearer ') 
      ? rawToken 
      : `Bearer ${rawToken}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Accept': '*/*',
        'x-api-key': 'voyager_ui',
        'x-gw-ims-org-id': config.orgId.trim(),
        'x-sandbox-name': config.sandbox.trim(),
        'Authorization': authHeader
      }
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const error = new Error(`Delete failed ${response.status}: ${errorText.slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }

    return { status: response.status, ok: response.ok };
  }

  /**
   * Verify credentials by making a test API call
   */
  async verifyCredentials(config) {
    const today = new Date().toISOString().slice(0, 10);
    const filter = `status=draft,failed,stopped,closed,finished,live,deployed&metadata.lastModifiedAt<${today}`;
    const url = `${AJO_BASE}?pageSize=1&page=0&filter=${encodeURIComponent(filter)}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'x-api-key': config.apiKey,
        'x-gw-ims-org-id': config.orgId,
        'x-sandbox-name': config.sandbox
      }
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const hint = response.status === 401 ? 'Invalid token or API key'
        : response.status === 403 ? 'Insufficient permissions'
        : response.status === 404 ? 'Sandbox not found'
        : `HTTP ${response.status}`;
      throw new Error(`${hint}${body ? ': ' + body.slice(0, 120) : ''}`);
    }

    const data = await response.json();
    return data.pagination?.totalCount ?? (data.results || []).length;
  }

  /**
   * Fetch campaigns for delivery summary (GraphQL)
   */
  async fetchCampaigns(config, startDate, endDate) {
    const startMs = startDate.getTime();
    const endMs = endDate.getTime();

    const query = `
      query searchV2($params: GlobalSearchRequestParams) {
        globalSearch(params: $params) {
          metrics {
            total_hits
            hits { hit capability }
          }
          result_sets {
            data {
              id name labels description created createdby modified modifiedby
              tags { id name tagCategoryId tagCategoryName }
              custom
            }
          }
        }
      }
    `;

    const variables = {
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
              { filterName: 'sandboxname', filterType: 'enum_values', anyOf: [config.sandbox] }
            ]
          },
          custom: [{
            filterList: [
              { filterName: 'status', filterType: 'enum_values', 
                anyOf: ['SCHEDULED', 'LIVE', 'IN_REVIEW', 'STOPPED', 'COMPLETED', 'FAILED', 'ARCHIVED'] },
              { filterName: 'trueStartDate', filterType: 'datetime', max: String(endMs) },
              { filterName: 'trueEndDate', filterType: 'datetime', min: String(startMs) },
              { filterName: 'status', filterType: 'enum_values', 
                anyOf: ['COMPLETED', 'STOPPED', 'LIVE'] }
            ],
            noun: 'campaign'
          }]
        }
      }
    };

    const response = await fetch(AJO_CAMPAIGN_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Authorization': `Bearer ${config.token}`,
        'x-api-key': 'exc_app',
        'x-gw-ims-org-id': config.orgId,
        'x-gw-region': 'VA7'
      },
      body: JSON.stringify({
        operationName: 'searchV2',
        query,
        variables,
        extensions: {
          clientContext: {
            applicationId: 'ajoCampaignsApp:prod',
            groupId: config.orgId
          }
        },
        sandboxName: config.sandbox,
        sandboxType: 'development',
        isDefaultSandbox: 'false'
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Campaign fetch failed ${response.status}: ${errorText.slice(0, 200)}`);
    }

    return response.json();
  }

  /**
   * Fetch journeys for delivery summary (GraphQL)
   */
  async fetchJourneysForDelivery(config, startDate, endDate) {
    const startMs = startDate.getTime();
    const endMs = endDate.getTime();

    const query = `
      query searchV2($params: GlobalSearchRequestParams) {
        globalSearch(params: $params) {
          metrics { total_hits hits { hit capability } }
          result_sets {
            data {
              id name labels description created createdby modified modifiedby custom
              tags { id name tagCategoryId tagCategoryName }
            }
          }
        }
      }
    `;

    const variables = {
      params: {
        isPostNounFilter: false,
        limit: 500,
        start_index: 0,
        sort_orderby: 'modified',
        filters: {
          standard: {
            filterList: [
              { filterName: 'noun', filterType: 'enum_values', anyOf: ['journey'] },
              { filterName: 'sandboxname', filterType: 'enum_values', anyOf: [config.sandbox] }
            ]
          },
          custom: [{
            filterList: [
              { filterName: 'startDate', filterType: 'datetime', max: String(endMs) },
              { filterName: 'endDateTimeline', filterType: 'datetime', min: String(startMs) },
              { filterName: 'state', filterType: 'enum_values', 
                anyOf: ['deployed', 'redeployed', 'finishedEmpty', 'stopped'] }
            ],
            noun: 'journey'
          }]
        }
      }
    };

    const response = await fetch(AJO_JOURNEY_GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Authorization': `Bearer ${config.token}`,
        'x-api-key': 'exc_app',
        'x-gw-ims-org-id': config.orgId,
        'x-gw-region': 'VA7'
      },
      body: JSON.stringify({
        operationName: 'searchV2',
        query,
        variables,
        extensions: { clientContext: {} },
        sandboxName: config.sandbox,
        sandboxType: 'development',
        isDefaultSandbox: 'false'
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Journey fetch failed ${response.status}: ${errorText.slice(0, 200)}`);
    }

    return response.json();
  }
}

export default new AJOApiService();
