/*
 * Action invocation utility
 * Handles calls to Adobe I/O Runtime actions
 */

/**
 * Invoke an App Builder action
 * @param {Object} config
 * @param {string} config.actionName - Name of the action to invoke
 * @param {Object} config.params - Parameters to pass to the action
 * @param {Object} config.headers - Optional headers
 * @param {string} config.imsToken - Optional IMS token for authorization
 * @returns {Promise<Object>} Action response
 */
async function actionWebInvoke({ actionName, params = {}, headers = {}, imsToken = null }) {
  // Get the action URL - use the deployed action URL from the deployment
  // The actions are deployed at: https://14257-ajodeliveryhub-stage.adobeio-static.net/api/v1/web/ajo-delivery-hub/
  const actionUrl = `/api/v1/web/ajo-delivery-hub/${actionName}`;
  
  console.log(`Invoking action: ${actionUrl}`);
  
  // Add Authorization header if IMS token is provided
  const authHeaders = imsToken ? { 'Authorization': `Bearer ${imsToken}` } : {};
  
  try {
    const response = await fetch(actionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...headers,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Action invocation failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    // If the action returned an error in the body, throw it
    if (data.error) {
      throw new Error(data.error);
    }

    // Return the body if it exists, otherwise return the whole response
    return data.body || data;
    
  } catch (error) {
    console.error(`Action ${actionName} failed:`, error);
    throw error;
  }
}

export default actionWebInvoke;
