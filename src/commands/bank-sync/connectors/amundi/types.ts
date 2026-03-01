import { ConnectorConfig } from '../../../../types.js';

/**
 * Amundi-specific configuration
 */
export interface Config extends ConnectorConfig {
  /**
   * @default ""
   */
  login: string;
  /**
   * @default ""
   */
  password: string;
}
