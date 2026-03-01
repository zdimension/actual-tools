import * as fs from 'fs/promises';
import * as path from 'path';
import Ajv from 'ajv';
import { RootConfig, AccountMapping, ConnectorConfig } from './types.js';
import { SchemaProvider } from './schema-provider.js';

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
   * Load configuration from disk, creating with defaults if missing
   */
  async load(): Promise<void> {
    let data: string;
    let fileExists = true;

    try {
      data = await fs.readFile(this.configPath, 'utf-8');
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, create empty object
        console.log('ℹ Config file not found, creating with defaults...');
        fileExists = false;
        data = '{}';
      } else {
        throw new Error(`Failed to read config from ${this.configPath}: ${error}`);
      }
    }

    try {
      this.config = JSON.parse(data);
    } catch (error) {
      throw new Error(`Failed to parse config JSON: ${error}`);
    }

    // Validate and apply defaults using AJV
    await this.validateAndApplyDefaults();

    // Save if file was created
    if (!fileExists) {
      await this.save();
      console.log('✓ Created config.json with default values');
    }
  }

  /**
   * Validate configuration and apply defaults using AJV
   */
  private async validateAndApplyDefaults(): Promise<void> {
    if (!this.config) {
      this.config = {} as RootConfig;
    }

    try {
      const schema = SchemaProvider.getSchema();
      const ajv = new Ajv({ useDefaults: true, strict: false });
      const validate = ajv.compile(schema);

      const valid = validate(this.config);
      if (!valid) {
        const errors = validate.errors?.map(e => `${e.instancePath}: ${e.message}`).join('\n');
        console.warn(`⚠ Config validation warnings:\n${errors}`);
      }
    } catch (error) {
      console.warn(`⚠ Could not validate config: ${error}`);
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

  /**
   * Register a new connector with default values from connector-specific schema
   * Creates a connector entry if it doesn't exist
   */
  async registerConnectorWithDefaults(connectorName: string): Promise<void> {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call load() first.');
    }

    // Ensure connectors object exists
    if (!this.config.connectors) {
      this.config.connectors = {};
    }

    // Don't overwrite an existing connector
    if (this.config.connectors[connectorName]) {
      return;
    }

    // Get connector-specific schema and apply defaults
    try {
      const schema = SchemaProvider.getConnectorSchema(connectorName);

      const ajv = new Ajv({ useDefaults: true, strict: false });
      const validate = ajv.compile(schema);

      // Start with empty object, validation with useDefaults will fill in all defaults
      const defaultConfig: ConnectorConfig = {};
      validate(defaultConfig);

      // Add the connector with defaults
      this.config.connectors[connectorName] = defaultConfig;
      await this.save();

      console.log(
        `Created config entry for connector '${connectorName}'. ` +
        `Please configure it in config.json with your credentials and account mappings.`,
      );
    } catch (error) {
      console.error(`Failed to register connector '${connectorName}':`, error);
      throw error;
    }
  }

  /**
   * Validate and fill missing fields for an existing connector entry
   * Does not save automatically - call save() if modifications were made
   * Returns { errors: array or null if valid, modified: boolean }
   */
  validateAndFillConnectorDefaults(connectorName: string): { errors: any[] | null; modified: boolean } {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call load() first.');
    }

    if (!this.config.connectors?.[connectorName]) {
      return { errors: [{ message: 'Connector not found in configuration' }], modified: false };
    }

    try {
      const schema = SchemaProvider.getConnectorSchema(connectorName);
      const ajv = new Ajv({ useDefaults: true, strict: false });
      const validate = ajv.compile(schema);

      // Deep clone the config to compare before and after
      const configBefore = JSON.stringify(this.config.connectors[connectorName]);
      
      // Validate and fill missing fields
      const valid = validate(this.config.connectors[connectorName]);
      
      // Compare to detect if defaults were added
      const configAfter = JSON.stringify(this.config.connectors[connectorName]);
      const modified = configBefore !== configAfter;

      return { 
        errors: valid ? null : (validate.errors || [{ message: 'Unknown validation error' }]), 
        modified 
      };
    } catch (error) {
      console.warn(`⚠ Could not validate connector '${connectorName}':`, error);
      return { errors: [{ message: `Validation exception: ${error}` }], modified: false };
    }
  }
}