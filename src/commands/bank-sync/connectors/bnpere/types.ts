import { ConnectorConfig } from '../../../../types.js';

/**
 * BNPERE-specific configuration
 */
export interface BNPEREConfig extends ConnectorConfig {
  login: string;
  password: string;
}
