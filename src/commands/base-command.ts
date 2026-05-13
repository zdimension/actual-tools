import * as path from 'path';
import { Command } from './command.interface.js';
import { ConfigManager } from '../config-manager.js';
import { ActualClient } from '../actual-client.js';
import { RootConfig } from '../types.js';
import { ArgumentParser } from './argparse.js';

/**
 * Base class for commands that need config and Actual client.
 * Handles common setup/teardown logic.
 */
export abstract class BaseCommand implements Command {
  abstract setupArgs(parser: ArgumentParser): void;
  abstract getDescription(): string;
  abstract executeWithClients(configManager: ConfigManager, actualClient: ActualClient, config: RootConfig, args: any): Promise<void>;

  async execute(args: string[]): Promise<void> {
    const parser = new ArgumentParser({ helpIfEmpty: false }); // Temporary workaround until we migrate to our own ArgumentParser2
    this.setupArgs(parser);
    const parsedArgs = parser.parse_args(args);

    const configPath = path.join(process.cwd(), 'config.json');
    const configManager = new ConfigManager(configPath);

    try {
      // Load configuration
      await configManager.load();
      const config = configManager.getConfig();

      // Initialize Actual client
      const actualClient = new ActualClient(config.actual);
      await actualClient.init();

      try {
        // Execute command-specific logic
        await this.executeWithClients(configManager, actualClient, config, parsedArgs);
      } finally {
        // Always cleanup
        await actualClient.shutdown();
      }
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  }
}
