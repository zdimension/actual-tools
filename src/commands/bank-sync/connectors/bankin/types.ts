import { ConnectorConfig } from '../../../../types.js';

/**
 * Bankin-specific configuration
 */
export interface BankinConfig extends ConnectorConfig {
  email: string;
  password: string;
  clientId?: string;
  clientSecret?: string;
}
