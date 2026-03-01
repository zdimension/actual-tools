import { ConnectorConfig } from '../../../../types.js';

/**
 * BourseDirect-specific configuration
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
  /**
   * @default ""
   */
  otpUrl?: string; // otpauth:// URL for automatic 2FA
}
