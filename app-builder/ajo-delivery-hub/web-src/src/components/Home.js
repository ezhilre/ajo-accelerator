/*
 * AJO Delivery Hub - Delivery Report Only
 */

import React, { useState } from 'react';
import {
  View,
  Heading,
  Text,
  Button,
  Flex,
  Content,
  IllustratedMessage,
  Well,
  ActionButton
} from '@adobe/react-spectrum';
import Settings from '@spectrum-icons/workflow/Settings';
import CredentialsModal from './CredentialsModal';
import DeliverySummary from './DeliverySummary';

export const Home = () => {
  const [credentials, setCredentials] = useState(null);
  const [showCredentialsModal, setShowCredentialsModal] = useState(false);

  // Check if credentials exist in session storage
  React.useEffect(() => {
    try {
      const saved = sessionStorage.getItem('ajo_credentials');
      if (saved) {
        setCredentials(JSON.parse(saved));
      }
    } catch (error) {
      console.error('Failed to load credentials:', error);
    }
  }, []);

  const handleSaveCredentials = (creds) => {
    setCredentials(creds);
    setShowCredentialsModal(false);
  };

  const handleConfigureCredentials = () => {
    setShowCredentialsModal(true);
  };

  const handleCloseModal = () => {
    setShowCredentialsModal(false);
  };

  if (!credentials) {
    // Show credential setup screen
    return (
      <View padding="size-400" width="100%">
        <Flex direction="column" alignItems="center" justifyContent="center" minHeight="60vh" gap="size-300">
          <IllustratedMessage>
            <Settings />
            <Heading>AJO Delivery Report</Heading>
            <Content>
              Configure your Adobe Journey Optimizer credentials to view monthly delivery reports.
            </Content>
          </IllustratedMessage>
          <Button variant="cta" onPress={handleConfigureCredentials}>
            <Settings />
            <Text>Configure Credentials</Text>
          </Button>
        </Flex>

        {showCredentialsModal && (
          <CredentialsModal
            isOpen={showCredentialsModal}
            onClose={handleCloseModal}
            onSave={handleSaveCredentials}
          />
        )}
      </View>
    );
  }

  // Show Delivery Summary
  return (
    <View padding="size-400" width="100%" height="100vh">
      <Flex direction="column" gap="size-300" height="100%">
        {/* Header */}
        <View>
          <Flex justifyContent="space-between" alignItems="center">
            <View>
              <Heading level={1}>AJO Delivery Report</Heading>
              <Text>
                Sandbox: <strong>{credentials.sandbox}</strong>
              </Text>
            </View>
            <ActionButton onPress={handleConfigureCredentials}>
              <Settings />
              <Text>Reconfigure</Text>
            </ActionButton>
          </Flex>
        </View>

        {/* Delivery Summary Component */}
        <DeliverySummary credentials={credentials} />

        {/* Credentials Modal */}
        {showCredentialsModal && (
          <CredentialsModal
            isOpen={showCredentialsModal}
            onClose={handleCloseModal}
            onSave={handleSaveCredentials}
            initialValues={credentials}
          />
        )}
      </Flex>
    </View>
  );
};
