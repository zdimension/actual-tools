import { ConnectorConfig } from '../../../../types.js';

/**
 * BourseDirect-specific configuration
 */
export interface BourseDirectConfig extends ConnectorConfig {
  login: string;
  password: string;
  otpUrl?: string; // otpauth:// URL for automatic 2FA
}
