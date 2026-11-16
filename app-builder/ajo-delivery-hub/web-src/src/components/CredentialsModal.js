/*
 * Credentials Configuration Modal
 * Captures and validates AJO API credentials
 */

import React, { useState } from 'react';
import {
  Dialog,
  DialogContainer,
  Divider,
  Content,
  Heading,
  Form,
  TextField,
  ButtonGroup,
  Button,
  Text,
  ProgressCircle,
  Flex,
  Well
} from '@adobe/react-spectrum';
import Alert from '@spectrum-icons/workflow/Alert';
import ajoApi from '../services/ajoApi';

const CredentialsModal = ({ isOpen, onClose, onSave, initialValues = null }) => {
  const [formData, setFormData] = useState({
    token: initialValues?.token || '',
    apiKey: initialValues?.apiKey || '',
    orgId: initialValues?.orgId || '',
    sandbox: initialValues?.sandbox || '',
    tenantId: initialValues?.tenantId || ''
  });
  
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState(null);

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    setError(null);
  };

  const handleSave = async () => {
    // Validate all fields are filled
    if (!formData.token || !formData.apiKey || !formData.orgId || !formData.sandbox || !formData.tenantId) {
      setError('All fields are required');
      return;
    }

    setIsVerifying(true);
    setError(null);

    try {
      // Verify credentials by making a test API call
      await ajoApi.verifyCredentials(formData);
      
      // Save to session storage
      sessionStorage.setItem('ajo_credentials', JSON.stringify(formData));
      
      // Call parent callback
      onSave(formData);
    } catch (err) {
      setError(err.message || 'Failed to verify credentials. Please check your inputs.');
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <DialogContainer onDismiss={onClose}>
      {isOpen && (
        <Dialog size="M">
          <Heading>Configure AJO Credentials</Heading>
          <Divider />
          <Content>
            <Form>
              <TextField
                label="Access Token"
                value={formData.token}
                onChange={(value) => handleChange('token', value)}
                width="100%"
                isRequired
                description="Bearer token from Adobe Developer Console"
                validationState={error && !formData.token ? 'invalid' : undefined}
              />
              
              <TextField
                label="API Key (Client ID)"
                value={formData.apiKey}
                onChange={(value) => handleChange('apiKey', value)}
                width="100%"
                isRequired
                description="From Adobe Developer Console project"
                validationState={error && !formData.apiKey ? 'invalid' : undefined}
              />
              
              <TextField
                label="Organization ID"
                value={formData.orgId}
                onChange={(value) => handleChange('orgId', value)}
                width="100%"
                isRequired
                description="Adobe IMS Org ID (e.g., ABC123@AdobeOrg)"
                validationState={error && !formData.orgId ? 'invalid' : undefined}
              />
              
              <TextField
                label="Sandbox Name"
                value={formData.sandbox}
                onChange={(value) => handleChange('sandbox', value)}
                width="100%"
                isRequired
                description="AJO sandbox name (e.g., prod)"
                validationState={error && !formData.sandbox ? 'invalid' : undefined}
              />
              
              <TextField
                label="Tenant ID"
                value={formData.tenantId}
                onChange={(value) => handleChange('tenantId', value)}
                width="100%"
                isRequired
                description="Adobe Experience Cloud tenant ID"
                validationState={error && !formData.tenantId ? 'invalid' : undefined}
              />

              {error && (
                <Well marginTop="size-200">
                  <Flex gap="size-100" alignItems="center">
                    <Alert color="negative" />
                    <Text UNSAFE_style={{ color: 'var(--spectrum-global-color-red-600)' }}>
                      {error}
                    </Text>
                  </Flex>
                </Well>
              )}
            </Form>
          </Content>
          
          <ButtonGroup>
            <Button variant="secondary" onPress={onClose} isDisabled={isVerifying}>
              Cancel
            </Button>
            <Button variant="cta" onPress={handleSave} isDisabled={isVerifying}>
              {isVerifying ? (
                <Flex gap="size-100" alignItems="center">
                  <ProgressCircle size="S" isIndeterminate />
                  <Text>Verifying...</Text>
                </Flex>
              ) : (
                'Save & Verify'
              )}
            </Button>
          </ButtonGroup>
        </Dialog>
      )}
    </DialogContainer>
  );
};

export default CredentialsModal;
