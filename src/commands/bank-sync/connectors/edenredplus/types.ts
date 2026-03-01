import { ConnectorConfig } from '../../../../types.js';

/**
 * EdenredPlus-specific configuration
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
