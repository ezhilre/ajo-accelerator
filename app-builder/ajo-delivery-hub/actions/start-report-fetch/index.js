/*
 * Start Report Fetch Action
 * Initiates an async report generation job and returns job ID immediately
 */

const { Core, State } = require('@adobe/aio-sdk');
const { errorResponse, checkMissingRequestInputs } = require('../utils');
const openwhisk = require('openwhisk');

async function main(params) {
  const logger = Core.Logger('start-report-fetch', { level: params.LOG_LEVEL || 'info' });

  try {
    logger.info('Start Report Fetch action invoked');

    // Extract IMS token from Authorization header
    const headers = params.__ow_headers || {};
    const authHeader = headers.authorization || headers.Authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    
    if (!token) {
      return errorResponse(401, 'Missing authorization token', logger);
    }

    // Validate required parameters
    const requiredParams = ['sandbox', 'year', 'month', 'type'];
    const errorMessage = checkMissingRequestInputs(params, requiredParams, []);
    if (errorMessage) {
      return errorResponse(400, errorMessage, logger);
    }

    // Generate unique job ID
    const jobId = `job-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    logger.info(`Created job ID: ${jobId}`);

    // Initialize State SDK
    const state = await State.init();

    // Create initial job status
    const jobStatus = {
      jobId,
      status: 'starting',
      stage: 'initializing',
      progress: 0,
      itemsProcessed: 0,
      itemsTotal: 0,
      message: 'Starting report generation...',
      params: {
        sandbox: params.sandbox,
        year: params.year,
        month: params.month,
        type: params.type
      },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Store initial status (TTL: 1 hour) - State requires string values
    await state.put(jobId, JSON.stringify(jobStatus), { ttl: 3600 });
    logger.info('Job status stored in State');

    // Invoke fetch-delivery-report action asynchronously using OpenWhisk
    try {
      logger.info('=== STARTING ASYNC ACTION INVOCATION ===');
      logger.info('Initializing OpenWhisk client...');
      const ow = openwhisk();
      logger.info('✓ OpenWhisk client initialized successfully');
      
      const actionName = 'ajo-delivery-hub/fetch-delivery-report';
      const invokeParams = {
        sandbox: params.sandbox,
        year: params.year,
        month: params.month,
        type: params.type,
        includeAI: params.includeAI !== 'false',
        jobId: jobId,
        token: token,
        __ow_headers: params.__ow_headers
      };
      
      logger.info(`Invoking action: ${actionName}`);
      logger.info('Invocation parameters:', { 
        sandbox: invokeParams.sandbox,
        year: invokeParams.year,
        month: invokeParams.month,
        type: invokeParams.type,
        includeAI: invokeParams.includeAI,
        jobId: invokeParams.jobId
      });
      
      // Invoke action asynchronously (non-blocking)
      const result = await ow.actions.invoke({
        name: actionName,
        params: invokeParams,
        blocking: false, // Non-blocking - don't wait for response
        result: false
      });
      
      logger.info('✓ Async action invoked successfully');
      logger.info('Activation ID:', result.activationId);

    } catch (invokeError) {
      logger.error('✗ ERROR INVOKING ASYNC ACTION');
      logger.error('Error type:', invokeError.constructor.name);
      logger.error('Error message:', invokeError.message);
      logger.error('Error stack:', invokeError.stack);
      
      // Update job status to show error
      try {
        const errorStatus = {
          jobId,
          status: 'failed',
          stage: 'invocation',
          progress: 0,
          itemsProcessed: 0,
          itemsTotal: 0,
          message: `Failed to start report generation: ${invokeError.message}`,
          error: invokeError.message,
          updatedAt: new Date().toISOString()
        };
        await state.put(jobId, JSON.stringify(errorStatus), { ttl: 3600 });
        logger.error('Job status updated with error state');
      } catch (stateError) {
        logger.error('Failed to update error status:', stateError);
      }
    }

    // Return job ID immediately
    return {
      statusCode: 202, // Accepted
      body: {
        jobId,
        message: 'Report generation started',
        pollInterval: 2000, // Suggest polling every 2 seconds
        statusEndpoint: 'get-report-status'
      }
    };

  } catch (error) {
    logger.error('Action failed:', error);
    return errorResponse(500, error.message, logger);
  }
}

exports.main = main;
