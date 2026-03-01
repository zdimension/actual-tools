import { ConnectorConfig } from '../../../../types.js';

/**
 * WiiSmile-specific configuration
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
