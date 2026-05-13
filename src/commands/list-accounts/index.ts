import { BaseCommand } from '../base-command.js';
import { ConfigManager } from '../../config-manager.js';
import { ActualClient } from '../../actual-client.js';
import { RootConfig } from '../../types.js';
import { ArgumentParser } from '../argparse.js';

export class ListAccountsCommand extends BaseCommand {
  setupArgs(parser: ArgumentParser): void {
    parser.add_argument('-a', '--all', { action: 'store_true', help: 'Show all accounts including closed' });
  }

  getDescription(): string {
    return 'List all Actual Budget accounts';
  }

  async executeWithClients(configManager: ConfigManager, actualClient: ActualClient, config: RootConfig, parsedArgs: { all?: boolean }): Promise<void> {
    // Get all accounts
    const accounts = await actualClient.getAccounts();

    // Display accounts in a table
    console.log('Actual Budget Accounts:');
    console.log('='.repeat(80));
    console.log(`${'ID'.padEnd(38)} | Display Name`);
    console.log('='.repeat(80));

    for (const account of accounts) {
      if (parsedArgs.all || !account.closed) {
        console.log(`${account.id.padEnd(38)} | ${account.name}`);
      }
    }

    console.log('='.repeat(80));
    const displayedCount = parsedArgs.all ? accounts.length : accounts.filter((a: any) => !a.closed).length;
    const suffix = parsedArgs.all ? '' : ' (excluding closed)';
    console.log(`\nTotal: ${displayedCount} accounts${suffix}\n`);
  }
}
