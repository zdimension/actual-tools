import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { utils } from '@actual-app/api';
import { BaseCommand } from '../base-command.js';
import { ConfigManager } from '../../config-manager.js';
import { ActualClient } from '../../actual-client.js';
import { BankinConnector } from './connectors/bankin/index.js';
import { BourseDirectConnector } from './connectors/boursedirect/index.js';
import { BNPEREConnector } from './connectors/bnpere/index.js';
import { WiiSmileConnector } from './connectors/wiismile/index.js';
import { AmundiConnector } from './connectors/amundi/index.js';
import { MyEdenredConnector } from './connectors/myedenred/index.js';
import { EdenredPlusConnector } from './connectors/edenredplus/index.js';
import { TwoFactorRequiredError } from './connectors/two-factor-error.js';
import { VendorAccount, ActualTransaction, VendorTransaction, RootConfig } from '../../types.js';
import { Connector } from './connectors/connector.interface.js';

export class BankSyncCommand extends BaseCommand {
  getDescription(): string {
    return 'Sync bank transactions from connectors to Actual Budget';
  }

  private parseArgs(args: string[]): { dryRun: boolean; connectors: string[] | null; summary: boolean; allManual: boolean } {
    const result = {
      dryRun: false,
      connectors: null as string[] | null,
      summary: false,
      allManual: false,
    };

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '--dry-run' || arg === '-d') {
        result.dryRun = true;
      } else if (arg === '--connectors' || arg === '-c') {
        const nextArg = args[i + 1];
        if (nextArg && !nextArg.startsWith('-')) {
          result.connectors = nextArg.split(',').map(c => c.trim());
          i++; // Skip next arg since we consumed it
        }
      } else if (arg === '--summary' || arg === '-s') {
        result.summary = true;
      } else if (arg === '--all-manual' || arg === '-m') {
        result.allManual = true;
      }
    }

    return result;
  }

  async executeWithClients(configManager: ConfigManager, actualClient: ActualClient, config: RootConfig, args: string[]): Promise<void> {
    const { dryRun, connectors, summary, allManual } = this.parseArgs(args);

    if (allManual && connectors && connectors.length > 0) {
      console.error('✗ Cannot use --all-manual (-m) together with --connectors (-c).');
      process.exit(1);
    }

    if (summary) {
      await this.runSummary(config);
      return;
    }
    await this.run(configManager, actualClient, config, dryRun, connectors, allManual);
  }

  private async runSummary(config: RootConfig): Promise<void> {
    console.log('Bank Sync Connectors Summary');
    console.log('='.repeat(80));
    for (const [connectorName, connectorConfig] of Object.entries(config.connectors)) {
      const status = connectorConfig.disabled ? 'Disabled' : 'Enabled';
      const lastRun = connectorConfig.lastSuccessfulRun ? new Date(connectorConfig.lastSuccessfulRun).toLocaleString() : 'Never';
      console.log(`${connectorName.padEnd(20)} | ${status.padEnd(10)} | Last Successful Run: ${lastRun}`);
    }
  }


  private async run(configManager: ConfigManager, actualClient: ActualClient, config: RootConfig, dryRun: boolean = false, connectorFilter: string[] | null = null, allManual: boolean = false): Promise<void> {
    if (dryRun) {
      console.log('🔍 DRY RUN MODE - No changes will be made to Actual\n');
    }

    // Register any missing connectors that were explicitly selected with -c
    if (connectorFilter && connectorFilter.length > 0) {
      for (const connectorName of connectorFilter) {
        // Check if connector is known
        if (!(await this.isKnownConnector(connectorName))) {
          const knownConnectors = await this.getKnownConnectors();
          console.error(`✗ Unknown connector: ${connectorName}`);
          console.error(`Available connectors: ${knownConnectors.join(', ')}`);
          await actualClient.shutdown();
          process.exit(1);
        }

        // Register if missing (manual mode only)
        if (!config.connectors[connectorName]) {
          await configManager.registerConnectorWithDefaults(connectorName);
          // Reload config to reflect the newly added connector
          await configManager.load();
          const updatedConfig = configManager.getConfig();
          config.connectors = updatedConfig.connectors;
          console.log(`✓ Created config entry for connector "${connectorName}"`);
        }
      }
    }

    // Validate and fill missing fields for all existing connector entries
    let configModified = false;
    const validationErrors: Map<string, any[]> = new Map();
    
    for (const connectorName of Object.keys(config.connectors)) {
      const { errors, modified } = configManager.validateAndFillConnectorDefaults(connectorName);
      
      if (errors) {
        validationErrors.set(connectorName, errors);
      }
      
      if (modified) {
        configModified = true;
      }
    }

    // Handle validation errors
    if (validationErrors.size > 0) {
      console.error('\n✗ Configuration validation failed for connectors:');
      for (const [name, errors] of validationErrors.entries()) {
        console.error(`\n  ${name}:`);
        for (const error of errors) {
          const path = error.instancePath || error.dataPath || '';
          const message = error.message || 'Unknown error';
          console.error(`    - ${path ? path + ': ' : ''}${message}`);
        }
      }
      console.error('\nPlease fix the configuration errors in config.json');
      await actualClient.shutdown();
      process.exit(1);
    }

    // Handle configuration modifications
    if (configModified) {
      await configManager.save();
      console.error('\n✗ Configuration was modified with default values.');
      console.error('Please review and update config.json with correct values before running bank-sync again.');
      await actualClient.shutdown();
      process.exit(1);
    }

    // Filter connectors if specified
    let connectorsToProcess = Object.entries(config.connectors);
    if (connectorFilter && connectorFilter.length > 0) {
      connectorsToProcess = connectorsToProcess.filter(([name]) => connectorFilter.includes(name));
      if (connectorsToProcess.length === 0) {
        console.error(`✗ No matching connectors found: ${connectorFilter.join(', ')}`);
        console.error(`Available connectors: ${Object.keys(config.connectors).join(', ')}`);
        await actualClient.shutdown();
        process.exit(1);
      }
      console.log(`ℹ Running only selected connectors: ${connectorsToProcess.map(([name]) => name).join(', ')}\n`);
    } else if (allManual) {
      connectorsToProcess = connectorsToProcess.filter(([, connectorConfig]) => connectorConfig.requiresManualRun);
      if (connectorsToProcess.length === 0) {
        console.error('✗ No connectors are marked as manual (requiresManualRun: true).');
        await actualClient.shutdown();
        process.exit(1);
      }
      console.log(`ℹ Running all manual connectors: ${connectorsToProcess.map(([name]) => name).join(', ')}\n`);
    }

    // Process each connector
    for (const [connectorName, connectorConfig] of connectorsToProcess) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Processing connector: ${connectorName}`);
      console.log('='.repeat(60));

      // Determine if this is a manual run (via -c or -m flags)
      const isManuallyRun = !!(connectorFilter || allManual);

      if (connectorConfig.disabled) {
        if (isManuallyRun) {
          console.log(`⚠ Connector ${connectorName} is disabled (${connectorConfig.disabled}), re-enabling it for this run...`);
          await configManager.updateConnectorDisabled(connectorName, false);
          // Reload config to reflect the change
          await configManager.load();
          const updatedConfig = configManager.getConfig();
          config.connectors = updatedConfig.connectors;
        } else {
          console.log(`⚠ Skipping connector ${connectorName} (disabled: ${connectorConfig.disabled})`);
          continue;
        }
      }

      // Skip connectors requiring manual run unless explicitly selected
      if (connectorConfig.requiresManualRun && !connectorFilter && !allManual) {
        console.log(`⚠ Skipping connector ${connectorName} (requires manual run - use -c ${connectorName} to run)`);
        continue;
      }

      try {
        await this.processConnector(
          connectorName,
          connectorConfig,
          configManager,
          actualClient,
          config.clientId || '',
          config.clientSecret || '',
          config,
          config.startCutoff,
          dryRun,
          isManuallyRun
        );
        
        // Update last successful run timestamp (only if not a dry run)
        if (!dryRun) {
          await configManager.updateLastSuccessfulRun(connectorName);
        }
      } catch (error) {
        if (error instanceof TwoFactorRequiredError) {
          console.error(`✗ ${connectorName} requires 2FA. Disabling connector...`);
          await configManager.updateConnectorDisabled(connectorName, '2fa');
          continue;
        }
        console.error(`✗ Error processing connector ${connectorName}:`, error);
      }
    }

    // Sync with server
    if (!dryRun) {
      console.log('\n\nSyncing with Actual server...');
      await actualClient.sync();
      console.log('✓ Sync complete');
    } else {
      console.log('\n\n🔍 Dry run complete - no changes were made');
    }

    console.log('\n✓ All done!');
  }

  private async processConnector(
    connectorName: string,
    connectorConfig: any,
    configManager: ConfigManager,
    actualClient: ActualClient,
    clientId: string,
    clientSecret: string,
    config: RootConfig,
    startCutoff?: string,
    dryRun: boolean = false,
    isManuallyRun: boolean = false
  ): Promise<void> {
    // Get the appropriate connector
    const connector = this.getConnector(connectorName, clientId, clientSecret);
    if (!connector) {
      console.error(`✗ Unknown connector: ${connectorName}`);
      return;
    }

    // Prepare data path for connector
    const dataPath = path.join(process.cwd(), 'data', connectorName);

    // Fetch data from connector
    const result = await connector.fetchTransactions(connectorConfig, dataPath, isManuallyRun);

    // Filter transactions by date if startCutoff is specified
    // Connector-specific startCutoff overrides global startCutoff
    const effectiveCutoff = connectorConfig.startCutoff || startCutoff;
    let filteredTransactions = result.transactions;
    
    if (effectiveCutoff && effectiveCutoff !== 'latest') {
      const originalCount = filteredTransactions.length;
      filteredTransactions = filteredTransactions.filter((t: VendorTransaction) => t.date >= effectiveCutoff);
      const filteredCount = originalCount - filteredTransactions.length;
      if (filteredCount > 0) {
        console.log(`  ℹ Filtered out ${filteredCount} transactions before ${effectiveCutoff}`);
      }
    }

    // Get account mapping
    const accountMapping = configManager.getAccountMapping(connectorName);

    // Build map of transactions by vendor account ID (single iteration)
    const transactionsByAccount = new Map<string, VendorTransaction[]>();
    for (const transaction of filteredTransactions) {
      if (!transactionsByAccount.has(transaction.vendorAccountId)) {
        transactionsByAccount.set(transaction.vendorAccountId, []);
      }
      transactionsByAccount.get(transaction.vendorAccountId)!.push(transaction);
    }

    // Track unmapped accounts
    const unmappedAccounts: Array<{ vendorId: string; name: string }> = [];

    // Process each account
    for (const account of result.accounts) {
      const vendorId = account.vendorId;
      const mappedValue = accountMapping[vendorId];

      // Get transactions for this account (pre-filtered by vendor account ID)
      let accountTransactions = transactionsByAccount.get(vendorId) || [];

      // If using "latest" cutoff, filter by latest transaction in the actual account
      if (effectiveCutoff === 'latest' && mappedValue && !mappedValue.startsWith('**') && mappedValue !== 'new') {
        const latestDate = await this.getLatestTransactionDate(actualClient, mappedValue);
        if (latestDate) {
          const nextDate = this.getNextDay(latestDate);
          const originalCount = accountTransactions.length;
          accountTransactions = accountTransactions.filter((t: VendorTransaction) => t.date >= nextDate);
          const filteredCount = originalCount - accountTransactions.length;
          if (filteredCount > 0) {
            //console.log(`  ℹ Account "${account.name}": filtered out ${filteredCount} transactions before ${nextDate} (latest: ${latestDate})`);
          }
        }
      }

      // Case 1: Not in mapping at all
      if (mappedValue === undefined) {
        unmappedAccounts.push({ vendorId, name: account.name });
        continue;
      }

      // Case 2: Mapped to ** prefix (user needs to set it)
      if (mappedValue.startsWith('**')) {
        console.log(`  ⚠ Skipping account "${account.name}" (${vendorId}) - not mapped yet`);
        continue;
      }

      // Case 3: Mapped to "new" - create account
      let actualAccountId: string;
      if (mappedValue === 'new') {
        if (dryRun) {
          console.log(`  🔍 [DRY RUN] Would create new account "${account.name}"`);
          actualAccountId = 'dry-run-account-id';
        } else {
          console.log(`  → Creating new account "${account.name}"...`);
          actualAccountId = await actualClient.createAccount(account.name, account.balance || 0);

          // Update config with the new account ID
          await configManager.updateAccountMapping(connectorName, vendorId, actualAccountId);
        }
      } else {
        // Case 4: Mapped to an actual account ID
        if (!dryRun) {
          console.log(`  → Importing transactions for "${account.name}"...`);
        } else {
          console.log(`  🔍 [DRY RUN] Would import transactions for "${account.name}"...`);
        }
        actualAccountId = mappedValue;
      }

      // Get all operations for this account (transactions + balance adjustments)
      const allOperations = await this.getAllAccountOperations(
        account,
        actualAccountId,
        accountTransactions,
        connectorName,
        actualClient,
        config,
        dryRun
      );

      // Import all operations at once
      await this.importOperations(
        account,
        actualAccountId,
        allOperations,
        actualClient,
        dryRun
      );

      // Update account balance for existing accounts
      if (!dryRun && mappedValue !== 'new' && account.balance !== undefined && account.balance !== null) {
        try {
          console.log(`  → Updating balance for "${account.name}" to ${account.balance.toFixed(2)}...`);
          await actualClient.updateAccount(actualAccountId, { balance_current: account.balance });
        } catch (error) {
          console.log(`    ⚠ Could not update balance: ${error}`);
        }
      }
    }

    // Add unmapped accounts to config
    if (unmappedAccounts.length > 0) {
      console.log(`\n  ⚠ Found ${unmappedAccounts.length} unmapped account(s):`);
      for (const account of unmappedAccounts) {
        console.log(`    - ${account.name} (${account.vendorId})`);
      }
      console.log('  → Adding to config.json...');
      await configManager.addUnmappedAccounts(connectorName, unmappedAccounts);
      console.log('  ✓ Please update config.json with Actual account IDs or "new" to auto-create');
    }
  }

  private async getAllAccountOperations(
    account: VendorAccount,
    actualAccountId: string,
    accountTransactions: VendorTransaction[],
    connectorName: string,
    actualClient: ActualClient,
    config: RootConfig,
    dryRun: boolean = false
  ): Promise<ActualTransaction[]> {
    // Format regular transactions
    const actualTransactions: ActualTransaction[] = accountTransactions.map(t => ({
      account: actualAccountId,
      date: t.date,
      amount: utils.amountToInteger(t.amount),
      imported_payee: t.originalLabel || t.label,
      imported_id: `${connectorName}/${t.vendorAccountId}/${t.vendorId}`,
    }));

    // Get balance adjustment if applicable
    const balanceAdjustment = await this.getInvestmentAccountBalanceAdjustment(
      account,
      actualAccountId,
      actualClient,
      config,
      connectorName
    );

    if (balanceAdjustment) {
      actualTransactions.push(balanceAdjustment);
    }

    return actualTransactions;
  }

  private async importOperations(
    account: VendorAccount,
    actualAccountId: string,
    operations: ActualTransaction[],
    actualClient: ActualClient,
    dryRun: boolean = false
  ): Promise<void> {
    if (operations.length === 0) {
      console.log(`    (no transactions)`);
      return;
    }

    /*if (dryRun) {
      // In dry-run mode, print all operations
      console.log(`    🔍 Would import ${operations.length} operation(s):`);
      for (const tx of operations.slice(0, 5)) {
        console.log(`      - ${tx.date}: ${(tx.amount / 100).toFixed(2)} - ${tx.imported_payee}`);
      }
      if (operations.length > 5) {
        console.log(`      ... and ${operations.length - 5} more`);
      }
    } else {
      // Import to Actual
      const result = await actualClient.importTransactions(actualAccountId, operations);

      console.log(`    ✓ Added: ${result.added.length}, Updated: ${result.updated.length}`);
    }*/

    // Import to Actual
    const result = await actualClient.importTransactions(actualAccountId, operations, dryRun);

    console.log(`    ✓ Added: ${result.added.length}, Updated: ${result.updated.length}`);
  }

  private getConnector(
    connectorName: string,
    clientId: string,
    clientSecret: string
  ): Connector | null {
    switch (connectorName.toLowerCase()) {
      case 'bankin':
        return new BankinConnector(clientId, clientSecret);
      case 'boursedirect':
        return new BourseDirectConnector();
      case 'bnpere':
        return new BNPEREConnector();
      case 'wiismile':
        return new WiiSmileConnector();
      case 'amundi':
        return new AmundiConnector();
      case 'myedenred':
        return new MyEdenredConnector();
      case 'edenredplus':
        return new EdenredPlusConnector();
      default:
        return null;
    }
  }

  /**
   * Get the date of the latest transaction in an account
   */
  private async getLatestTransactionDate(actualClient: ActualClient, accountId: string): Promise<string | null> {
    try {
      const transactions = await actualClient.getTransactions(accountId);
      if (transactions.length === 0) {
        return null;
      }

      // Find the latest transaction date
      let latestDate = transactions[0].date;
      for (const tx of transactions) {
        if (tx.date > latestDate) {
          latestDate = tx.date;
        }
      }

      return latestDate;
    } catch (error) {
      console.error(`  ⚠ Could not fetch latest transaction date: ${error}`);
      return null;
    }
  }

  /**
   * Get the next day after a given date (YYYY-MM-DD format)
   */
  private getNextDay(dateStr: string): string {
    const date = new Date(dateStr);
    date.setDate(date.getDate() + 1);
    return date.toISOString().split('T')[0];
  }

  /**
   * Get balance adjustment operation for investment accounts if needed
   * Compares vendor balance with actual real balance and returns adjustment operation if different
   */
  private async getInvestmentAccountBalanceAdjustment(
    account: VendorAccount,
    actualAccountId: string,
    actualClient: ActualClient,
    config: RootConfig,
    connectorName: string
  ): Promise<ActualTransaction | null> {
    if (!account.isInvestment) {
      return null; // Not an investment account, skip
    }

    if (!config.balanceCategory) {
      console.log(`  ⚠ Investment account "${account.name}" but no balanceCategory configured`);
      return null;
    }

    try {
      // Get the real balance from Actual
      const realBalance = await actualClient.getAccountBalance(actualAccountId, null);
      const vendorBalance = utils.amountToInteger(account.balance);
      const delta = vendorBalance - realBalance;

      if (delta === 0) {
        return null; // Balance already correct
      }

      // Create an adjustment operation for today
      const today = new Date().toISOString().split('T')[0];

      const adjustmentOp: ActualTransaction = {
        account: actualAccountId,
        date: today,
        amount: delta,
        imported_payee: 'Mise à jour solde',
        imported_id: `${connectorName}/${account.vendorId}/balance-adjustment-${today}`,
        category: config.balanceCategory,
      };

      return adjustmentOp;
    } catch (error) {
      console.log(`  ⚠ Could not handle balance update: ${error}`);
      return null;
    }
  }

  /**
   * Get list of all known connector names
   */
  private async getKnownConnectors(): Promise<string[]> {
    try {
      const currentFile = fileURLToPath(import.meta.url);
      const connectorsDir = path.join(path.dirname(currentFile), 'connectors');
      const entries = await fs.readdir(connectorsDir, { withFileTypes: true });
      const dirNames = entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort();
      return dirNames;
    } catch (error) {
      console.error('Failed to read connectors directory:', error);
      return [];
    }
  }

  /**
   * Check if a connector name is known
   */
  private async isKnownConnector(name: string): Promise<boolean> {
    const knownConnectors = await this.getKnownConnectors();
    return knownConnectors.includes(name.toLowerCase());
  }
}