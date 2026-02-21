import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { BaseCommand } from '../base-command.js';
import { ConfigManager } from '../../config-manager.js';
import { ActualClient } from '../../actual-client.js';
import { RootConfig } from '../../types.js';

const execAsync = promisify(exec);

interface BalancePoint {
  date: string;
  balance: number;
}

export class PlotBalanceCommand extends BaseCommand {
  getDescription(): string {
    return 'Plot account balance history over time';
  }

  private parseArgs(args: string[]): {
    owner: string | null;
    exclude: string | null;
    ownerTotals: boolean;
  } {
    const result = {
      owner: null as string | null,
      exclude: null as string | null,
      ownerTotals: false,
    };

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if ((arg === '--owner' || arg === '-o') && args[i + 1]) {
        result.owner = args[i + 1];
        i++;
      } else if ((arg === '--exclude' || arg === '-x') && args[i + 1]) {
        result.exclude = args[i + 1];
        i++;
      } else if (arg === '--owner-totals' || arg === '-t') {
        result.ownerTotals = true;
      }
    }

    return result;
  }

  async executeWithClients(
    configManager: ConfigManager,
    actualClient: ActualClient,
    config: RootConfig,
    args: string[]
  ): Promise<void> {
    const { owner, exclude, ownerTotals } = this.parseArgs(args);

    console.log('Fetching accounts...');
    let accounts = await actualClient.getAccounts();

    // Filter by owner (first word of account name)
    if (owner) {
      accounts = accounts.filter((acc: any) => {
        const firstWord = acc.name.split(/\s+/)[0];
        return firstWord === owner;
      });
      console.log(`Filtered to owner "${owner}": ${accounts.length} accounts`);
    }

    // Exclude accounts matching regex
    if (exclude) {
      const excludeRegex = new RegExp(exclude, 'i');
      const beforeCount = accounts.length;
      accounts = accounts.filter((acc: any) => !excludeRegex.test(acc.name));
      console.log(`Excluded pattern "${exclude}": ${beforeCount - accounts.length} accounts removed`);
    }

    if (accounts.length === 0) {
      console.log('No accounts to plot.');
      return;
    }

    console.log(`Processing ${accounts.length} accounts...`);

    // Collect balance history for each account
    const accountData: Array<{
      account: any;
      history: BalancePoint[];
    }> = [];

    for (const account of accounts) {
      console.log(`  Processing: ${account.name}`);
      const transactions = await actualClient.getTransactions(account.id);

      // Sort transactions by date
      transactions.sort((a: any, b: any) => a.date.localeCompare(b.date));

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

    // Generate plot data
    const traces: any[] = [];

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
        // Collect all unique dates
        const allDates = new Set<string>();
        for (const { history } of ownerAccounts) {
          for (const point of history) {
            allDates.add(point.date);
          }
        }

        const sortedDates = Array.from(allDates).sort();

        // Calculate total balance at each date
        const ownerHistory: BalancePoint[] = [];

        for (const date of sortedDates) {
          let total = 0;

          for (const { history } of ownerAccounts) {
            // Find the balance at or before this date
            let balance = 0;
            for (const point of history) {
              if (point.date <= date) {
                balance = point.balance;
              } else {
                break;
              }
            }
            total += balance;
          }

          ownerHistory.push({ date, balance: total });
        }

        traces.push({
          name: `${ownerName} (Total)`,
          x: ownerHistory.map(p => p.date),
          y: ownerHistory.map(p => p.balance),
          mode: 'lines',
          line: { shape: 'hv', width: 3, dash: 'dash' },
          type: 'scatter',
        });
      }
    }

    // Generate HTML with Plotly
    const html = this.generateHtml(traces, owner, exclude, ownerTotals);

    // Save HTML file
    const outputPath = path.join(process.cwd(), 'balance-plot.html');
    await fs.writeFile(outputPath, html, 'utf-8');

    console.log(`\n✓ Plot saved to: ${outputPath}`);
    console.log('  Opening in browser...');

    // Open in default browser
    await this.openInBrowser(outputPath);
  }

  private async openInBrowser(filePath: string): Promise<void> {
    const platform = process.platform;

    try {
      if (platform === 'win32') {
        // Windows
        await execAsync(`start "" "${filePath}"`);
      } else if (platform === 'darwin') {
        // macOS
        await execAsync(`open "${filePath}"`);
      } else {
        // Linux
        await execAsync(`xdg-open "${filePath}"`);
      }
    } catch (error) {
      console.error(`  ⚠ Could not open browser automatically: ${error}`);
      console.log(`  Please open ${filePath} manually.`);
    }
  }

  private generateHtml(traces: any[], owner: string | null, exclude: string | null, ownerTotals: boolean): string {
    const title = this.buildTitle(owner, exclude, ownerTotals);

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Account Balance History</title>
  <script src="https://cdn.plot.ly/plotly-3.3.0.min.js"></script>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 20px;
    }
    #plot {
      width: 100%;
      height: 800px;
    }
  </style>
</head>
<body>
  <h1>Account Balance History</h1>
  <div id="plot"></div>
  <script>
    const data = ${JSON.stringify(traces, null, 2)};
    
    const layout = {
      title: '${title}',
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
        yanchor: 'top'
      }
    };
    
    const config = {
      responsive: true,
      displayModeBar: true,
      displaylogo: false
    };
    
    Plotly.newPlot('plot', data, layout, config);
  </script>
</body>
</html>`;
  }

  private buildTitle(owner: string | null, exclude: string | null, ownerTotals: boolean): string {
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

    return parts.join(' - ');
  }
}
