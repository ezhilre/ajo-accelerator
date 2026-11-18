/*
 * Get Report Status Action
 * Returns current status and progress of a report generation job
 */

const { Core, State } = require('@adobe/aio-sdk');
const { errorResponse, checkMissingRequestInputs } = require('../utils');

async function main(params) {
  const logger = Core.Logger('get-report-status', { level: params.LOG_LEVEL || 'info' });

  try {
    // Validate required parameters
    const requiredParams = ['jobId'];
    const errorMessage = checkMissingRequestInputs(params, requiredParams, []);
    if (errorMessage) {
      return errorResponse(400, errorMessage, logger);
    }

    const jobId = params.jobId;
    logger.info(`Checking status for job: ${jobId}`);

    // Initialize State SDK
    const state = await State.init();

    try {
      // Get job status from state
      const jobStatus = await state.get(jobId);

      if (!jobStatus || !jobStatus.value) {
        logger.warn(`Job not found: ${jobId}`);
        return {
          statusCode: 404,
          body: {
            error: 'Job not found',
            jobId
          }
        };
      }

      // Parse the JSON string value from state
      const status = JSON.parse(jobStatus.value);
      logger.info(`Job ${jobId} status: ${status.status}, stage: ${status.stage}, progress: ${status.progress}%`);

      // Return current status
      return {
        statusCode: 200,
        body: status
      };

    } catch (error) {
      // State not found
      if (error.code === 'ERROR_STATE_NOT_FOUND' || error.message.includes('404')) {
        logger.warn(`Job not found in state: ${jobId}`);
        return {
          statusCode: 404,
          body: {
            error: 'Job not found or expired',
            jobId
          }
        };
      }
      throw error;
    }

  } catch (error) {
    logger.error('Action failed:', error);
    return errorResponse(500, error.message, logger);
  }
}

exports.main = main;
