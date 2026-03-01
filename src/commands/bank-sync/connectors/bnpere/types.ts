import { ConnectorConfig } from '../../../../types.js';

/**
 * BNPERE-specific configuration
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
