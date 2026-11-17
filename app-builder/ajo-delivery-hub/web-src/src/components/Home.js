/*
 * AJO Delivery Hub - Delivery Report Only
 */

import React from 'react';
import {
  View,
  Heading,
  Text,
  Flex
} from '@adobe/react-spectrum';
import DeliverySummary from './DeliverySummary';

export const Home = ({ ims }) => {
  // Build credentials from IMS token only
  const credentials = React.useMemo(() => {
    if (!ims?.token) return null;
    
    return {
      token: ims.token,
      orgId: ims.org // From IMS runtime
    };
  }, [ims]);

  if (!credentials) {
    // Show loading state while waiting for IMS token
    return (
      <View padding="size-400" width="100%">
        <Flex direction="column" alignItems="center" justifyContent="center" minHeight="60vh" gap="size-300">
          <Heading>AJO Delivery Report</Heading>
          <Text>Loading...</Text>
        </Flex>
      </View>
    );
  }

  // Show Delivery Summary
  return (
    <View padding="size-400" width="100%" height="100vh">
      <Flex direction="column" gap="size-300" height="100%">
        {/* Header */}
        <View>
          <Heading level={1}>AJO Delivery Report</Heading>
          <Text>Organization: <strong>{credentials.orgId}</strong></Text>
        </View>

        {/* Delivery Summary Component */}
        <DeliverySummary credentials={credentials} />
      </Flex>
    </View>
  );
};
