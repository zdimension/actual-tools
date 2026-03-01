import { ConnectorConfig } from '../../../../types.js';

/**
 * MyEdenred-specific configuration
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
