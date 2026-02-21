import { ConnectorConfig } from '../../../../types.js';

/**
 * WiiSmile-specific configuration
 */
export interface WiiSmileConfig extends ConnectorConfig {
  login: string;
  password: string;
}
