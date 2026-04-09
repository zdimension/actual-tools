import * as api from '@actual-app/api';
import { utils } from '@actual-app/api';
import { ActualConfig, ActualTransaction } from './types.js';
import { APICategoryEntity, APICategoryGroupEntity } from '@actual-app/api/@types/loot-core/src/server/api-models.js';

/**
 * Wrapper around the Actual Budget API
 */
export class ActualClient {
  private config: ActualConfig;
  private initialized: boolean = false;

  constructor(config: ActualConfig) {
    this.config = config;
  }

  /**
   * Initialize connection to Actual Budget server
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Validate required configuration
    const errors: string[] = [];
    if (!this.config.url?.trim()) {
      errors.push('actual.url is required and cannot be empty');
    }
    if (!this.config.password?.trim()) {
      errors.push('actual.password is required and cannot be empty');
    }
    if (!this.config.syncId?.trim()) {
      errors.push('actual.syncId is required and cannot be empty');
    }

    if (errors.length > 0) {
      console.error('✗ Invalid Actual Budget configuration:');
      for (const error of errors) {
        console.error(`  - ${error}`);
      }
      throw new Error('Cannot connect to Actual Budget: missing required configuration');
    }

    try {
      await api.init({
        serverURL: this.config.url,
        password: this.config.password,
        dataDir: './actual-cache',
        verbose: false
      });

      await api.downloadBudget(this.config.syncId);
      
      this.initialized = true;
      console.log('✓ Connected to Actual Budget');
    } catch (error) {
      throw new Error(`Failed to initialize Actual API: ${error}`);
    }
  }

  /**
   * Get all accounts from Actual
   */
  async getAccounts(): Promise<any[]> {
    this.ensureInitialized();
    return await api.getAccounts();
  }

  /**
   * Get all categories from Actual
   */
  async getCategories(): Promise<(APICategoryEntity | APICategoryGroupEntity)[]> {
    this.ensureInitialized();
    return await api.getCategories();
  }

  /**
   * Get all category groups from Actual
   */
  async getCategoryGroups(): Promise<any[]> {
    this.ensureInitialized();
    return await api.getCategoryGroups();
  }

  /**
   * Get all transactions for a specific account
   * @param accountId Account ID
   * @param startDate Start date (YYYY-MM-DD), empty string means no filter (default: '')
   * @param endDate End date (YYYY-MM-DD), empty string means no filter (default: '')
   */
  async getTransactions(accountId: string, startDate: string = '', endDate: string = ''): Promise<any[]> {
    this.ensureInitialized();
    return await api.getTransactions(accountId, startDate, endDate);
  }

  /**
   * Get account balance at a specific point in time
   * @param accountId Account ID
   * @param cutoff Date (YYYY-MM-DD string) to calculate balance up to, null for current balance
   * @returns Balance in cents
   */
  async getAccountBalance(accountId: string, cutoff: string | null = null): Promise<number> {
    this.ensureInitialized();
    const cutoffDate = cutoff === null ? undefined : new Date(cutoff);
    return await api.getAccountBalance(accountId, cutoffDate);
  }

  /**
   * Create a new account in Actual
   * @param name Account display name
   * @param initialBalance Initial account balance in decimal format (euros, dollars, etc.)
   * @param offbudget Whether this is an off-budget account (default: false)
   * @returns The ID of the newly created account
   */
  async createAccount(name: string, initialBalance: number = 0, offbudget: boolean = false): Promise<string> {
    this.ensureInitialized();
    
    try {
      // Convert initial balance from decimal to integer cents
      const balanceInCents = utils.amountToInteger(initialBalance);
      
      const accountId = await api.createAccount({
        name,
        offbudget,
      }, balanceInCents);
      
      console.log(`✓ Created account "${name}" with ID: ${accountId}`);
      return accountId;
    } catch (error) {
      throw new Error(`Failed to create account "${name}": ${error}`);
    }
  }

  /**
   * Update account balance and other properties
   */
  async updateAccount(
    accountId: string,
    properties: { balance_current?: number; name?: string; offbudget?: boolean; closed?: boolean }
  ): Promise<void> {
    this.ensureInitialized();

    try {
      // Convert balance_current from decimal to integer cents
      const updateProps = { ...properties };
      if (updateProps.balance_current !== undefined) {
        updateProps.balance_current = utils.amountToInteger(updateProps.balance_current);
      }
      
      // Use 'as any' since balance_current exists in DbAccount at runtime
      // even though it's not in the public APIAccountEntity type definition
      await api.updateAccount(accountId, updateProps as any);
    } catch (error) {
      throw new Error(`Failed to update account ${accountId}: ${error}`);
    }
  }

  /**
   * Import transactions to an account
   * Uses Actual's importTransactions which handles duplicates via imported_id
   */
  async importTransactions(
    accountId: string,
    transactions: ActualTransaction[],
    dryRun: boolean = false
  ): Promise<{ added: string[]; updated: string[] }> {
    this.ensureInitialized();

    try {
      const normalizedTransactions = transactions.map(tx => ({
        ...tx,
        payee_name: tx.payee_name || tx.imported_payee,
      }));

      const result = await api.importTransactions(accountId, normalizedTransactions, {
        dryRun
      });
      
      if (result.errors && result.errors.length > 0) {
        console.error(`⚠ Errors importing transactions:`, result.errors);
      }

      return {
        added: result.added || [],
        updated: result.updated || [],
      };
    } catch (error) {
      throw new Error(`Failed to import transactions to account ${accountId}: ${error}`);
    }
  }

  /**
   * Sync with the server
   */
  async sync(): Promise<void> {
    this.ensureInitialized();
    await api.sync();
  }

  /**
   * Shutdown the API connection
   */
  async shutdown(): Promise<void> {
    if (this.initialized) {
      await api.shutdown();
      this.initialized = false;
      console.log('✓ Disconnected from Actual Budget');
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('ActualClient not initialized. Call init() first.');
    }
  }
}
