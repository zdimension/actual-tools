import { exec } from 'child_process';
import { promisify } from 'util';
import LZString from 'lz-string';
import { BaseCommand } from '../base-command.js';
import { ConfigManager } from '../../config-manager.js';
import { ActualClient } from '../../actual-client.js';
import { RootConfig } from '../../types.js';
import { TransactionEntity } from '@actual-app/api/@types/loot-core/src/types/models/transaction.js';

const execAsync = promisify(exec);

// ── Types ─────────────────────────────────────────────────────────────────────

interface SankeyNode {
  id: string;
  label: string;
  layer: 'income' | 'owner' | 'expense';
}

interface SankeyLink {
  source: string; // node id
  target: string; // node id
  value: number;  // always positive
}

// ── Command ───────────────────────────────────────────────────────────────────

export class SankeyCommand extends BaseCommand {
  getDescription(): string {
    return 'Show account flow as a Sankey diagram (income → owner → expense)  [-o owner] [-g]';
  }

  async executeWithClients(
    _configManager: ConfigManager,
    actualClient: ActualClient,
    _config: RootConfig,
    args: string[]
  ): Promise<void> {
    // Optional -o / --owner filter (comma-separated list of owner names)
    const ownerFilterArg = this.getArg(args, ['-o', '--owner']);
    const ownerFilter = ownerFilterArg
      ? new Set(ownerFilterArg.split(',').map(s => s.trim()))
      : null;

    // Optional -g / --group: group by category group instead of leaf category
    const useGroups = args.includes('-g') || args.includes('--group');

    console.log('Fetching accounts, categories and transactions…');

    const [accounts, categoryList, groupList] = await Promise.all([
      actualClient.getAccounts(),
      actualClient.getCategories(),
      actualClient.getCategoryGroups(),
    ]);

    // Category id → leaf name, and category id → group name
    const catName  = new Map<string, string>();
    const catGroup = new Map<string, string>();
    for (const group of groupList as any[]) {
      for (const c of (group.categories ?? []) as any[]) {
        if (c.id && c.name) {
          catName.set(c.id, c.name);
          catGroup.set(c.id, group.name);
        }
      }
    }
    // Also pick up any leaves from the flat list that getCategoryGroups may not cover
    for (const c of categoryList as any[]) {
      if (c.id && c.name && !c.categories && !catName.has(c.id)) {
        catName.set(c.id, c.name);
      }
    }

    // Active accounts only
    const activeAccounts = (accounts as any[]);//.filter(a => !a.closed);

    // owner → categoryId → sum (in euros)
    const flow = new Map<string, Map<string, number>>();

    for (const acc of activeAccounts) {
      const owner = acc.name.split(/\s+/)[0];
      if (ownerFilter && !ownerFilter.has(owner)) continue;

      const accTxs = await actualClient.getTransactions(acc.id);
      const txs: TransactionEntity[] = [
        // only take non-splitted transactions
        ...accTxs.filter(t => !t.is_parent && !t.is_child),
        // only take child transactions
        ...accTxs.filter(t => t.is_parent).flatMap(t => t.subtransactions ?? []),
      ];

      for (const tx of txs) {
        if (tx.transfer_id) continue;  // skip transfers (they clutter the diagram and don't represent real inflow/outflow)
        if (!tx.category) tx.category = 'N/A';

        const amountEur = (tx.amount ?? 0) / 100;

        if (!flow.has(owner)) flow.set(owner, new Map());
        const ownerFlow = flow.get(owner)!;
        ownerFlow.set(tx.category, (ownerFlow.get(tx.category) ?? 0) + amountEur);
      }
    }

    if (flow.size === 0) {
      console.log('No data to display.');
      return;
    }

    // ── Build Sankey nodes & links ────────────────────────────────────────────

    const nodes: SankeyNode[] = [];
    const links: SankeyLink[] = [];

    // Node id helpers to avoid duplicates across sides
    const nodeSet = new Set<string>();
    const addNode = (node: SankeyNode) => {
      if (!nodeSet.has(node.id)) {
        nodeSet.add(node.id);
        nodes.push(node);
      }
    };

    const owners = Array.from(flow.keys()).sort();

    for (const owner of owners) {
      const ownerNodeId = `owner:${owner}`;

      addNode({ id: ownerNodeId, label: owner, layer: 'owner' });
      addNode({ id: `balance:${owner}`, label: `${owner} balance`, layer: 'owner' });

      const ownerFlow = flow.get(owner)!;

      const totalBalance = Array.from(ownerFlow.values()).reduce((sum, v) => sum + v, 0);
      if (totalBalance < 0) {
        links.push({ source: `balance:${owner}`, target: ownerNodeId, value: -totalBalance });
      } else if (totalBalance > 0) {
        links.push({ source: ownerNodeId, target: `balance:${owner}`, value: totalBalance });
      }
      
      // When grouping, accumulate by group key first, then emit links
      const groupedFlow = useGroups
        ? (() => {
            const agg = new Map<string, number>();
            for (const [catId, total] of ownerFlow) {
              const key = catGroup.get(catId) ?? catName.get(catId) ?? catId;
              agg.set(key, (agg.get(key) ?? 0) + total);
            }
            return agg;
          })()
        : new Map(Array.from(ownerFlow).map(([catId, total]) => [
            catName.get(catId) ?? catId, total,
          ]));

      for (const [label, total] of groupedFlow) {
        if (Math.abs(total) < 0.005) continue;   // ignore rounding noise

        if (total > 0) {
          // Income: category/group → owner
          const catNodeId = `income:${label}`;
          addNode({ id: catNodeId, label: `+${label}`, layer: 'income' });
          links.push({ source: catNodeId, target: ownerNodeId, value: total });
        } else {
          // Expense: owner → category/group
          const catNodeId = `expense:${label}`;
          addNode({ id: catNodeId, label: `-${label}`, layer: 'expense' });
          links.push({ source: ownerNodeId, target: catNodeId, value: -total });
        }
      }
    }

    await this.openInSankeymatic(nodes, links);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private getArg(args: string[], flags: string[]): string | null {
    for (let i = 0; i < args.length; i++) {
      if (flags.includes(args[i]) && args[i + 1]) return args[i + 1];
    }
    return null;
  }

  private async openInSankeymatic(nodes: SankeyNode[], links: SankeyLink[]): Promise<void> {
    // Build a label lookup: node id → display label
    const labelOf = new Map(nodes.map(n => [n.id, n.label]));

    const lines: string[] = [];

    // Flow lines: Source [AMOUNT] Target
    for (const link of links) {
      const src = labelOf.get(link.source) ?? link.source;
      const tgt = labelOf.get(link.target) ?? link.target;
      const amt = Math.round(link.value * 100) / 100;   // 2 dp
      lines.push(`${src} [${amt}] ${tgt}`);
    }

    const code = lines.join('\n');
    const encoded = LZString.compressToEncodedURIComponent(code);
    const url = `https://sankeymatic.com/build/?i=${encoded}`;

    console.log(`\n✓ Opening SankeyMATIC…`);
    console.log(`  URL length: ${url.length} chars`);
    try {
      await this.openInBrowser(url);
    } catch (err) {
      console.error(`  ⚠ Could not open browser automatically: ${err}`);
      console.log(`  URL: ${url}`);
    }
  }

  private async openInBrowser(url: string): Promise<void> {
    const p = process.platform;
    if (p === 'win32') await execAsync(`start "" "${url}"`);
    else if (p === 'darwin') await execAsync(`open "${url}"`);
    else await execAsync(`xdg-open "${url}"`);
  }

}
