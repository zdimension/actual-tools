import { BaseCommand } from '../base-command.js';
import { ConfigManager } from '../../config-manager.js';
import { ActualClient } from '../../actual-client.js';
import { RootConfig } from '../../types.js';

export class ListAccountsCommand extends BaseCommand {
  getDescription(): string {
    return 'List all Actual Budget accounts';
  }

  async executeWithClients(configManager: ConfigManager, actualClient: ActualClient, config: RootConfig, args: string[]): Promise<void> {
    // Get all accounts
    const accounts = await actualClient.getAccounts();

    // Display accounts in a table
    console.log('Actual Budget Accounts:');
    console.log('='.repeat(80));
    console.log(`${'ID'.padEnd(38)} | Display Name`);
    console.log('='.repeat(80));

    for (const account of accounts) {
      if (!account.closed) {
        console.log(`${account.id.padEnd(38)} | ${account.name}`);
      }
    }

    console.log('='.repeat(80));
    console.log(`\nTotal: ${accounts.filter((a: any) => !a.closed).length} accounts (excluding closed)\n`);
  }
}
