import * as fs from 'fs/promises';
import * as path from 'path';
import { RootConfig, AccountMapping, ConnectorConfig } from './types.js';

/**
 * Manages reading and writing the configuration file
 */
export class ConfigManager {
  private configPath: string;
  private config: RootConfig | null = null;

  constructor(configPath: string) {
    this.configPath = path.resolve(configPath);
  }

  /**
   * Load configuration from disk
   */
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      this.config = JSON.parse(data);
    } catch (error) {
      throw new Error(`Failed to load config from ${this.configPath}: ${error}`);
    }
  }

  /**
   * Save configuration to disk
   */
  async save(): Promise<void> {
    if (!this.config) {
      throw new Error('No configuration loaded');
    }

    try {
      const data = JSON.stringify(this.config, null, 4);
      await fs.writeFile(this.configPath, data, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to save config to ${this.configPath}: ${error}`);
    }
  }

  /**
   * Get the entire configuration
   */
  getConfig(): RootConfig {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call load() first.');
    }
    return this.config;
  }

  /**
   * Get connector-specific configuration
   */
  getConnectorConfig(connectorName: string): ConnectorConfig {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call load() first.');
    }

    const connectorConfig = this.config.connectors[connectorName];
    if (!connectorConfig) {
      throw new Error(`Connector "${connectorName}" not found in configuration`);
    }

    return connectorConfig;
  }

  /**
   * Get account mapping for a connector
   */
  getAccountMapping(connectorName: string): AccountMapping {
    const connectorConfig = this.getConnectorConfig(connectorName);
    return connectorConfig.accountMapping || {};
  }

  /**
   * Add unmapped accounts to the configuration
   * Sets their value to "**{display name}" to indicate they need manual mapping
   */
  async addUnmappedAccounts(
    connectorName: string,
    accounts: Array<{ vendorId: string; name: string }>
  ): Promise<void> {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call load() first.');
    }

    const connectorConfig = this.getConnectorConfig(connectorName);
    
    // Initialize accountMapping if it doesn't exist
    if (!connectorConfig.accountMapping) {
      connectorConfig.accountMapping = {};
    }

    let hasChanges = false;
    for (const account of accounts) {
      if (!(account.vendorId in connectorConfig.accountMapping)) {
        connectorConfig.accountMapping[account.vendorId] = `**${account.name}`;
        hasChanges = true;
      }
    }

    if (hasChanges) {
      await this.save();
    }
  }

  /**
   * Update a specific account mapping
   */
  async updateAccountMapping(
    connectorName: string,
    vendorId: string,
    actualAccountId: string
  ): Promise<void> {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call load() first.');
    }

    const connectorConfig = this.getConnectorConfig(connectorName);
    
    if (!connectorConfig.accountMapping) {
      connectorConfig.accountMapping = {};
    }

    connectorConfig.accountMapping[vendorId] = actualAccountId;
    await this.save();
  }

  /**
   * Update connector disabled status (truthy disables the connector)
   */
  async updateConnectorDisabled(connectorName: string, disabled: string | boolean): Promise<void> {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call load() first.');
    }

    const connectorConfig = this.getConnectorConfig(connectorName);
    connectorConfig.disabled = disabled;
    await this.save();
  }

  /**
   * Update the last successful run timestamp for a connector
   */
  async updateLastSuccessfulRun(connectorName: string): Promise<void> {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call load() first.');
    }

    const connectorConfig = this.getConnectorConfig(connectorName);
    connectorConfig.lastSuccessfulRun = new Date().toISOString();
    await this.save();
  }

  /**
   * Check if an account is mapped
   */
  isAccountMapped(connectorName: string, vendorId: string): boolean {
    const mapping = this.getAccountMapping(connectorName);
    const value = mapping[vendorId];
    return value !== undefined && !value.startsWith('**');
  }

  /**
   * Get the Actual account ID for a vendor account
   * Returns null if not mapped or starts with ** (unmapped)
   */
  getActualAccountId(connectorName: string, vendorId: string): string | null {
    const mapping = this.getAccountMapping(connectorName);
    const value = mapping[vendorId];
    return value && !value.startsWith('**') ? value : null;
  }
}
