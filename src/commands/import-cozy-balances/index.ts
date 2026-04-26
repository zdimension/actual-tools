import { BaseCommand } from '../base-command.js';
import { ConfigManager } from '../../config-manager.js';
import { ActualClient } from '../../actual-client.js';
import { RootConfig, ActualTransaction } from '../../types.js';
import { utils } from '@actual-app/api';

interface CozyDoc {
  _id: string;
  _rev: string;
  [key: string]: any;
}

interface CozyResponse {
  rows: Array<{
    id: string;
    doc: CozyDoc;
  }>;
}

export class ImportCozyBalancesCommand extends BaseCommand {
  private baseUrl: string = '';
  private token: string = '';

  getDescription(): string {
    return 'Import balance history from Cozy for specified Actual accounts';
  }

  async executeWithClients(
    configManager: ConfigManager,
    actualClient: ActualClient,
    config: RootConfig,
    args: string[]
  ): Promise<void> {
    // Parse CLI parameters
    const parsedArgs = this.parseArgs(args);
    
    // Get base URL and token from CLI or environment variables
    this.baseUrl = parsedArgs.baseUrl || process.env.BASE_URL || '';
    this.token = parsedArgs.token || process.env.TOKEN || '';

    if (!this.baseUrl) {
      console.error('❌ BASE_URL must be provided via --base-url parameter or BASE_URL environment variable');
      process.exit(1);
    }

    if (!this.token) {
      console.error('❌ TOKEN must be provided via --token parameter or TOKEN environment variable');
      process.exit(1);
    }

    if (!this.baseUrl.endsWith('/')) {
      this.baseUrl += '/';
    }

    if (!config.balanceUpdate?.categoryId) {
      console.error('❌ balance update category must be configured in config.json');
      process.exit(1);
    }

    // Parse account IDs from command line
    if (parsedArgs.accountIds.length === 0) {
      console.error('❌ Please specify at least one Actual account ID');
      console.error('Usage: npm start -- import-cozy-balances [--base-url <url>] [--token <token>] <accountId1> [accountId2] ...');
      process.exit(1);
    }

    const actualAccountIds = parsedArgs.accountIds;

    console.log(`📊 Importing balance history for ${actualAccountIds.length} account(s)\n`);

    // Get all Actual accounts to map names
    const actualAccounts = await actualClient.getAccounts();
    const actualAccountMap = new Map(actualAccounts.map(a => [a.id, a]));

    // Get Cozy accounts and balance histories
    console.log('Fetching Cozy accounts...');
    const cozyAccounts = await this.getCozyDocs('io.cozy.bank.accounts');
    
    console.log('Fetching Cozy balance histories...');
    const cozyBalanceHistories = await this.getCozyDocs('io.cozy.bank.balancehistories');

    console.log(`✓ Found ${cozyBalanceHistories.length} balance history documents\n`);

    // Process each Actual account
    for (const actualAccountId of actualAccountIds) {
      const actualAccount = actualAccountMap.get(actualAccountId);
      if (!actualAccount) {
        console.error(`⚠ Actual account ${actualAccountId} not found, skipping`);
        continue;
      }

      console.log(`\n📈 Processing: ${actualAccount.name} (${actualAccountId})`);

      // Find matching Cozy account by name
      const cozyAccount = cozyAccounts.find(ca => ca.shortLabel === actualAccount.name);
      if (!cozyAccount) {
        console.error(`  ⚠ No matching Cozy account found with shortLabel="${actualAccount.name}"`);
        continue;
      }

      console.log(`  ✓ Matched to Cozy account: ${cozyAccount.shortLabel} (${cozyAccount._id})`);

      // Find balance histories for this Cozy account and merge by date
      const matchingHistories = cozyBalanceHistories.filter(
        bh => bh.relationships?.account?.data?._id === cozyAccount._id
      );

      if (matchingHistories.length === 0) {
        console.error(`  ⚠ No balance history found for this account`);
        continue;
      }

      const balances = matchingHistories.reduce<Record<string, number>>((acc, history) => {
        if (history.balances) {
          Object.assign(acc, history.balances);
        }
        return acc;
      }, {});
      const dates = Object.keys(balances).sort();

      if (dates.length === 0) {
        console.log(`  ℹ No balance entries found`);
        continue;
      }

      console.log(`  ℹ Processing ${dates.length} balance entries...`);

      let adjustmentsCreated = 0;

      for (const date of dates) {
        const cozyBalance = balances[date];
        
        // Get Actual balance at this date (with 1-day offset)
        const cutoffDate = this.addDays(date, -1);
        const actualBalance = await actualClient.getAccountBalance(actualAccountId, cutoffDate);
        const cozyBalanceInCents = utils.amountToInteger(cozyBalance);
        
        const delta = cozyBalanceInCents - actualBalance;

        if (delta !== 0) {
          console.log(`  → ${date}: Delta ${(delta / 100).toFixed(2)} (Cozy: ${(cozyBalanceInCents / 100).toFixed(2)}, Actual: ${(actualBalance / 100).toFixed(2)})`);

          // Create balance adjustment transaction
          const adjustment: ActualTransaction = {
            account: actualAccountId,
            date: date,
            amount: delta,
            imported_payee: 'Mise à jour solde',
            imported_id: `cozy-balance/${cozyAccount._id}/${date}`,
            category: config.balanceUpdate!.categoryId,
          };

          await actualClient.importTransactions(actualAccountId, [adjustment]);
          adjustmentsCreated++;
        }
      }

      if (adjustmentsCreated > 0) {
        console.log(`  ✓ Created ${adjustmentsCreated} balance adjustment(s)`);
      } else {
        console.log(`  ✓ All balances match, no adjustments needed`);
      }
    }

    console.log('\n✅ Balance history import complete');
  }

  private addDays(date: string, days: number): string {
    const dt = new Date(date);
    dt.setDate(dt.getDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  private parseArgs(args: string[]): { baseUrl?: string; token?: string; accountIds: string[] } {
    const result: { baseUrl?: string; token?: string; accountIds: string[] } = {
      accountIds: [],
    };

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      
      if (arg === '--base-url' && i + 1 < args.length) {
        result.baseUrl = args[i + 1];
        i++; // Skip next arg
      } else if (arg === '--token' && i + 1 < args.length) {
        result.token = args[i + 1];
        i++; // Skip next arg
      } else if (!arg.startsWith('--')) {
        result.accountIds.push(arg);
      }
    }

    return result;
  }

  private async getCozyDocs(doctype: string): Promise<CozyDoc[]> {
    const reqUrl = `${this.baseUrl}data/${doctype}/_all_docs?include_docs=true`;

    const response = await fetch(reqUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
      }
    });

    if (response.status !== 200) {
      const text = await response.text();
      if (text.includes('Expired token')) {
        console.error('❌ Token expired, please refresh it');
      }
      console.error('❌ Error while fetching documents');
      console.error(text);
      process.exit(1);
    }

    const json = await response.json() as CozyResponse;
    return json.rows
      .filter(row => !row.id.includes('_design'))
      .map(row => row.doc);
  }
}
