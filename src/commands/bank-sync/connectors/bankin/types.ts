import { ConnectorConfig } from '../../../../types.js';

/**
 * Bankin-specific configuration
 */
export interface Config extends ConnectorConfig {
  /**
   * @default ""
   */
  email: string;
  /**
   * @default ""
   */
  password: string;
}
