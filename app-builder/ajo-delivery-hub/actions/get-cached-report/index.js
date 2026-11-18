/*
 * Get Cached Report Action
 * Checks if a cached report exists for the given parameters
 * Uses State SDK with 30-day TTL
 */

const { Core, State } = require('@adobe/aio-sdk');
const { errorResponse, checkMissingRequestInputs } = require('../utils');

const CACHE_TTL_DAYS = 30;

async function main(params) {
  const logger = Core.Logger('get-cached-report', { level: params.LOG_LEVEL || 'info' });

  try {
    logger.info('========================================');
    logger.info('Get Cached Report action invoked');
    logger.info('Params received:', JSON.stringify(params, null, 2));

    // Validate required parameters
    const requiredParams = ['sandbox', 'year', 'month', 'type'];
    const errorMessage = checkMissingRequestInputs(params, requiredParams, []);
    if (errorMessage) {
      logger.error('Missing required params:', errorMessage);
      return errorResponse(400, errorMessage, logger);
    }

    // Build cache key from parameters
    const cacheKey = `report-${params.sandbox}-${params.year}-${params.month}-${params.type}`;
    logger.info(`Cache key built: ${cacheKey}`);
    logger.info(`Looking for cache in State store...`);

    // Initialize State SDK
    const state = await State.init();

    try {
      // Try to read cached report from State
      const cachedValue = await state.get(cacheKey);
      
      if (!cachedValue || !cachedValue.value) {
        logger.info('Cache miss - no cached report found');
        return {
          statusCode: 200,
          body: {
            found: false,
            reason: 'not_found'
          }
        };
      }

      const cachedData = JSON.parse(cachedValue.value);

      // Check if cache is expired (30 days) - though State TTL should handle this
      const cachedAt = new Date(cachedData.cachedAt);
      const now = new Date();
      const ageInDays = (now - cachedAt) / (1000 * 60 * 60 * 24);

      if (ageInDays > CACHE_TTL_DAYS) {
        logger.info(`Cache expired (${Math.round(ageInDays)} days old), deleting...`);
        await state.delete(cacheKey);
        return {
          statusCode: 200,
          body: {
            found: false,
            reason: 'expired'
          }
        };
      }

      logger.info(`Cache hit! Age: ${Math.round(ageInDays)} days`);
      logger.info(`Cache contains ${cachedData.report?.combined?.length || 0} items`);

      return {
        statusCode: 200,
        body: {
          found: true,
          cacheKey,
          cachedAt: cachedData.cachedAt,
          ageInDays: Math.round(ageInDays * 10) / 10, // Round to 1 decimal
          stats: cachedData.stats,
          report: cachedData.report
        }
      };

    } catch (error) {
      // State key not found - cache miss
      if (error.message && error.message.includes('does not exist')) {
        logger.info('Cache miss - key does not exist in State');
        return {
          statusCode: 200,
          body: {
            found: false,
            reason: 'not_found'
          }
        };
      }
      throw error; // Re-throw unexpected errors
    }

  } catch (error) {
    logger.error('Action failed:', error);
    return errorResponse(500, error.message, logger);
  }
}

exports.main = main;
