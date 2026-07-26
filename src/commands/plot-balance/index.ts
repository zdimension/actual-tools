import { BaseCommand } from '../base-command.js';
import { ConfigManager } from '../../config-manager.js';
import { ActualClient } from '../../actual-client.js';
import { RootConfig } from '../../types.js';
import { ArgumentParser } from '../argparse.js';
import { APIAccountEntity } from '@actual-app/api/models';
import { openPlot } from '../../plotly.js';
import { utils } from '@actual-app/api';

interface BalancePoint {
  date: string;
  balance: number;
}

interface AccountBalanceData {
  account: APIAccountEntity;
  history: BalancePoint[];
}

export class PlotBalanceCommand extends BaseCommand {
  getDescription(): string {
    return 'Plot account balance history over time';
  }

  setupArgs(parser: ArgumentParser): void {
    parser.add_argument('-o', '--owner', { help: 'Filter accounts by owner (first word of account name)' });
    parser.add_argument('-x', '--exclude', { help: 'Exclude accounts matching regex pattern' });
    parser.add_argument('-t', '--owner-totals', { action: 'store_true', help: 'Include total balance per owner (dashed lines)' });
    parser.add_argument('-T', '--grand-total', { action: 'store_true', help: 'Include grand total balance across all plotted accounts' });
    parser.add_argument('-F', '--acc-filter', { help: 'Filter accounts by JS expression, e.g. _.name.includes("savings")' });
  }

  async executeWithClients(
    configManager: ConfigManager,
    actualClient: ActualClient,
    config: RootConfig,
    parsedArgs: { owner?: string; exclude?: string; ownerTotals: boolean; grandTotal: boolean; accFilter?: string }
  ): Promise<void> {
    const { owner, exclude, ownerTotals, grandTotal, accFilter } = parsedArgs;
    console.log(JSON.stringify({ owner, exclude, ownerTotals, grandTotal, accFilter }, null, 2));

    console.log('Fetching accounts...');
    let accounts = await actualClient.getAccounts();

    // Filter by owner (first word of account name)
    if (owner) {
      accounts = accounts.filter((acc) => {
        const firstWord = acc.name.split(/\s+/)[0];
        return firstWord === owner;
      });
      console.log(`Filtered to owner "${owner}": ${accounts.length} accounts`);
    }

    // Exclude accounts matching regex
    if (exclude) {
      const excludeRegex = new RegExp(exclude, 'i');
      const beforeCount = accounts.length;
      accounts = accounts.filter((acc) => !excludeRegex.test(acc.name));
      console.log(`Excluded pattern "${exclude}": ${beforeCount - accounts.length} accounts removed`);
    }

    if (accFilter) {
      const accFilterFunc = eval(`(_) => (${accFilter})`) as (acc: APIAccountEntity) => boolean;
      const beforeCount = accounts.length;
      accounts = accounts.filter(accFilterFunc);
      console.log(`Applied account filter "${accFilter}": ${beforeCount - accounts.length} accounts removed`);
    }

    if (accounts.length === 0) {
      console.log('No accounts to plot.');
      return;
    }

    console.log(`Processing ${accounts.length} accounts...`);

    // Collect balance history for each account
    const accountData: AccountBalanceData[] = [];

    // Generate plot data
    const traces: any[] = [];
    const shapes: any[] = [];

    for (const account of accounts) {
      console.log(`  Processing: ${account.name}`);
      const transactions = await actualClient.getTransactions(account.id);

      const isInvestment = config.balanceUpdate.categoryId && transactions.some(tx => tx.category === config.balanceUpdate.categoryId);

      // Sort transactions by date
      transactions.sort((a, b) => a.date.localeCompare(b.date));

      // Calculate running balance with one point per day in a single loop
      const history: BalancePoint[] = [];
      let runningBalance = 0;

      for (const tx of transactions) {
        runningBalance += tx.amount || 0;
        
        // If last point has same date, update it; otherwise add new point
        if (history.length > 0 && history[history.length - 1].date === tx.date) {
          history[history.length - 1].balance = runningBalance / 100;
        } else {
          history.push({
            date: tx.date,
            balance: runningBalance / 100, // Convert cents to dollars/euros
          });
        }

        // add vlines to mark investments/withdrawals
        if (isInvestment && tx.transfer_id) {
          shapes.push({
            type: 'line',
            x0: tx.date,
            x1: tx.date,
            y0: 0,
            y1: runningBalance / 100,
            line: {
              color: tx.amount > 0 ? 'green' : 'red',
              width: 1,
              dash: 'dot',
            },
            name: `${tx.date}: ${utils.integerToAmount(tx.amount || 0).toFixed(2)}`,
            legendgroup: account.id,
            showlegend: false,
          });
        }
      }

      // Add balance_current at end with current timestamp (for non-closed accounts)
      if (!account.closed && account.balance_current !== undefined && account.balance_current !== null) {
        const now = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
        history.push({
          date: now,
          balance: account.balance_current / 100,
        });
      }

      accountData.push({ account, history });
    }

    // Individual account traces
    for (const { account, history } of accountData) {
      if (history.length === 0) continue;

      traces.push({
        name: account.name,
        x: history.map(p => p.date),
        y: history.map(p => p.balance),
        mode: 'lines',
        line: { shape: 'hv' },
        type: 'scatter',
        legendgroup: account.id
      });
    }

    // Owner totals traces
    if (ownerTotals && accountData.length > 0) {
      // Group accounts by owner (first word)
      const ownerGroups = new Map<string, typeof accountData>();

      for (const data of accountData) {
        const ownerName = data.account.name.split(/\s+/)[0];
        if (!ownerGroups.has(ownerName)) {
          ownerGroups.set(ownerName, []);
        }
        ownerGroups.get(ownerName)!.push(data);
      }

      // Calculate owner totals
      for (const [ownerName, ownerAccounts] of ownerGroups) {
        const ownerHistory = this.buildTotalHistory(ownerAccounts);

        traces.push({
          name: `${ownerName} (Total)`,
          x: ownerHistory.map(p => p.date),
          y: ownerHistory.map(p => p.balance),
          mode: 'lines',
          line: { shape: 'hv', dash: 'dot' },
          type: 'scatter',
        });
      }
    }

    if (grandTotal && accountData.length > 0) {
      const grandHistory = this.buildTotalHistory(accountData);

      traces.push({
        name: 'Grand Total',
        x: grandHistory.map(p => p.date),
        y: grandHistory.map(p => p.balance),
        mode: 'lines',
        line: { shape: 'hv', dash: 'dash', width: 3 },
        type: 'scatter',
      });
    }

    // Build layout + config and open plot in browser using shared helper
    const title = this.buildTitle(owner, exclude, ownerTotals, grandTotal);

    const layout = {
      title,
      xaxis: {
        title: 'Date',
        type: 'date',
        hoverformat: '%Y-%m-%d'
      },
      yaxis: {
        title: 'Balance',
        tickformat: '.2f'
      },
      hovermode: 'closest',
      showlegend: true,
      legend: {
        x: 1.02,
        y: 1,
        xanchor: 'left',
        yanchor: 'top',
        tracegroupgap: 0,
      },
      shapes
    };

    await openPlot(traces, layout, {
      responsive: true,
      displayModeBar: true,
      displaylogo: false
    });
  }

  // HTML generation and browser-open logic moved to src/plotly.ts

  private buildTotalHistory(accountData: AccountBalanceData[]): BalancePoint[] {
    const allDates = new Set<string>();
    for (const { history } of accountData) {
      for (const point of history) {
        allDates.add(point.date);
      }
    }

    return Array.from(allDates).sort().map(date => ({
      date,
      balance: accountData.reduce((total, { history }) => total + this.getBalanceAtDate(history, date), 0),
    }));
  }

  private getBalanceAtDate(history: BalancePoint[], date: string): number {
    let balance = 0;

    for (const point of history) {
      if (point.date <= date) {
        balance = point.balance;
      } else {
        break;
      }
    }

    return balance;
  }

  private buildTitle(owner: string | null, exclude: string | null, ownerTotals: boolean, grandTotal: boolean): string {
    const parts: string[] = ['Account Balances'];

    if (owner) {
      parts.push(`Owner: ${owner}`);
    }

    if (exclude) {
      parts.push(`Exclude: ${exclude}`);
    }

    if (ownerTotals) {
      parts.push('with Owner Totals');
    }

    if (grandTotal) {
      parts.push('with Grand Total');
    }

    return parts.join(' - ');
  }
}
