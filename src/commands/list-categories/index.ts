import { BaseCommand } from '../base-command.js';
import { ConfigManager } from '../../config-manager.js';
import { ActualClient } from '../../actual-client.js';
import { RootConfig } from '../../types.js';
import { APICategoryEntity, APICategoryGroupEntity } from '@actual-app/api/@types/loot-core/src/server/api-models.js';

export class ListCategoriesCommand extends BaseCommand {
  getDescription(): string {
    return 'List all categories grouped by parent group';
  }

  async executeWithClients(configManager: ConfigManager, actualClient: ActualClient, config: RootConfig, args: string[]): Promise<void> {
    // Get all categories and groups
    const categories = await actualClient.getCategories();
    const groupItems = await actualClient.getCategoryGroups();

    const categoryItems = categories as APICategoryEntity[];

    const groupMap = new Map<string, APICategoryGroupEntity>();
    for (const group of groupItems) {
      groupMap.set(group.id, group);
    }

    // Group by group_id
    const grouped = new Map<string | null, APICategoryEntity[]>();
    for (const cat of categoryItems) {
      const groupId = cat.group_id || null;
      if (!grouped.has(groupId)) {
        grouped.set(groupId, []);
      }
      grouped.get(groupId)!.push(cat);
    }

    // Display categories grouped by parent
    console.log('Actual Budget Categories:');
    console.log('='.repeat(100));

    // Sort groups: null first, then by group name
    const sortedGroups = Array.from(grouped.entries()).sort((a, b) => {
      if (a[0] === null) return -1;
      if (b[0] === null) return 1;
      const groupA = groupMap.get(a[0]);
      const groupB = groupMap.get(b[0]);
      return (groupA?.name || '').localeCompare(groupB?.name || '');
    });

    for (const [groupId, items] of sortedGroups) {
      if (groupId === null) {
        console.log('\n[No Group]');
      } else {
        const group = groupMap.get(groupId);
        console.log(`\n${group?.name || 'Unknown Group'}`);
      }
      
      console.log('-'.repeat(100));
      console.log(`${'Name'.padEnd(40)} | ${'ID'.padEnd(38)} | Hidden`);
      console.log('-'.repeat(100));

      items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      for (const cat of items) {
        const hidden = cat.hidden ? 'Yes' : 'No';
        console.log(`${(cat.name || '').padEnd(40)} | ${cat.id.padEnd(38)} | ${hidden}`);
      }
    }

    console.log('='.repeat(100));
    console.log(`\nTotal: ${categoryItems.length} categories\n`);
  }
}
