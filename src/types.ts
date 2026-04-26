/**
 * Type definitions for the actual-tools connector system
 */

/**
 * Maps vendor account IDs to Actual account IDs
 * - Key: Vendor-specific account ID
 * - Value: Actual account ID (UUID), "new" to auto-create, or "" if unmapped
 */
export type AccountMapping = Record<string, string>;

/**
 * Actual server configuration
 */
export interface ActualConfig {
  /**
   * Actual Budget server URL
   * @default ""
   */
  url: string;

  /**
   * Actual Budget server password
   * @default ""
   */
  password: string;

  /**
   * Actual Budget sync ID (UUID)
   * @default ""
   */
  syncId: string;
}

/**
 * Base configuration structure for any connector
 */
export interface ConnectorConfig {
  /**
   * Maps vendor account IDs to Actual account IDs
   */
  accountMapping?: AccountMapping;

  /**
   * Connector-specific transaction start date (YYYY-MM-DD), overrides global
   */
  startCutoff?: string;

  /**
   * Disables connector; can be boolean or reason string (e.g., "2fa")
   */
  disabled?: string | boolean;

  /**
   * If true, connector only runs when explicitly specified with -c flag
   */
  requiresManualRun?: boolean;

  /**
   * ISO timestamp of last successful run
   */
  lastSuccessfulRun?: string | null;

  [key: string]: any; // Additional connector-specific fields
}

/**
 * Account information from a connector/bank
 */
export interface VendorAccount {
  vendorId: string; // Unique ID from the connector
  name: string; // Display name
  balance: number; // Current balance
  institutionLabel?: string; // Bank name
  isInvestment?: boolean; // Whether to track balance changes (default: false)
}

/**
 * Raw transaction from a connector/bank
 */
export interface VendorTransaction {
  vendorId: string; // Unique ID from the connector
  vendorAccountId: string; // Account ID this transaction belongs to
  date: string; // YYYY-MM-DD
  amount: number; // Amount in cents (or smallest currency unit)
  label: string; // Description/payee
  originalLabel?: string; // Raw bank description
}

/**
 * Transaction formatted for Actual API
 */
export interface ActualTransaction {
  account: string; // Actual account ID
  date: string; // YYYY-MM-DD
  amount: number; // Amount in cents
  imported_payee: string; // Original bank description
  payee_name?: string; // Payee name (optional)
  imported_id: string; // Format: {connector}/{vendorAccountId}/{vendorTransactionId}
  category?: string; // Category ID (optional)
}

/**
 * Result returned by connector's fetchTransactions method
 */
export interface FetchTransactionsResult {
  accounts: VendorAccount[];
  transactions: VendorTransaction[];
}

/**
 * Root configuration structure
 */
export interface RootConfig {
  /**
   * Client ID for Bankin API authentication
   * @default ""
   */
  clientId?: string;

  /**
   * Client secret for Bankin API authentication
   * @default ""
   */
  clientSecret?: string;

  /**
   * Default start date for transaction import (YYYY-MM-DD) or 'latest'
   * @default ""
   */
  startCutoff?: string;

  /**
   * Balance update config
   */
  balanceUpdate?: {
    /**
     * Category ID for balance update transactions
     * @default ""
     */
    categoryId: string;

    /**
     * Number of days between balance updates (e.g., 7 for weekly)
     * @default 7
     */
    frequencyDays: number;
  };

  /**
   * Category ID for interest/dividend credit transactions
   * @default ""
   */
  interestCategory?: string;

  /**
   * Actual Budget server configuration
   * @default {}
   */
  actual: ActualConfig;

  /**
   * Connector configurations
   * Each connector maps account names to their individual configs
   * e.g. { "boursedirect": { "tom": { ... }, "alice": { ... } } }
   * @default {}
   */
  connectors: {
    [connectorName: string]: {
      [accountName: string]: ConnectorConfig;
    };
  };
}
