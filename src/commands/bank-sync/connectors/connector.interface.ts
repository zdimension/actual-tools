import { ConnectorConfig, FetchTransactionsResult } from '../../../types.js';

/**
 * Interface that all connectors must implement
 */
export interface Connector {
  /**
   * Fetch transactions from the connector
   * @param config Connector-specific configuration
   * @param dataPath Path to store connector-specific data (tokens, cache, etc.)
   * @param isManuallyRun Whether the connector is being run manually (via -c or -m flags)
   * @returns Accounts and transactions from the connector
   */
  fetchTransactions(
    config: ConnectorConfig,
    dataPath: string,
    isManuallyRun?: boolean
  ): Promise<FetchTransactionsResult>;
}
