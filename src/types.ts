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
  url: string;
  password: string;
  sync_id: string;
}

/**
 * Base configuration structure for any connector
 */
export interface ConnectorConfig {
  accountMapping?: AccountMapping;
  startCutoff?: string; // YYYY-MM-DD - connector-specific cutoff, overrides global
  disabled?: string | boolean; // truthy disables connector; value is reason (e.g., "2fa")
  requiresManualRun?: boolean; // if true, connector only runs when explicitly specified with -c flag
  lastSuccessfulRun?: string | null; // ISO timestamp of last successful run (null if never run)
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
  clientId?: string;
  clientSecret?: string;
  startCutoff?: string; // YYYY-MM-DD - only import transactions on or after this date
  balanceCategory?: string; // Category ID for balance update operations
  actual: ActualConfig;
  connectors: {
    [connectorName: string]: ConnectorConfig;
  };
}
