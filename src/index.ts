import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Command } from './commands/command.interface.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Dynamically discover and load available commands
 */
async function discoverCommands(): Promise<Map<string, Command>> {
  const commands = new Map<string, Command>();
  const commandsDir = path.join(__dirname, 'commands');

  try {
    const entries = await fs.readdir(commandsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const commandName = entry.name;
        const commandIndexPath = path.join(commandsDir, commandName, 'index.js');

        try {
          // Check if index.js exists
          await fs.access(commandIndexPath);

          // Dynamically import the command
          const commandModule = await import(`./commands/${commandName}/index.js`);

          // Look for a class that implements Command interface
          // Convention: NameCommand class (e.g., BankSyncCommand, ListAccountsCommand)
          const CommandClass = Object.values(commandModule).find(
            (value: any) => value && typeof value === 'function' && value.prototype?.execute
          );

          if (CommandClass) {
            const command = new (CommandClass as any)() as Command;
            commands.set(commandName, command);
          }
        } catch (error) {
          // Skip commands that can't be loaded
          console.error(`Warning: Could not load command '${commandName}':`, error);
        }
      }
    }
  } catch (error) {
    console.error('Error discovering commands:', error);
  }

  return commands;
}

/**
 * Display help message with available commands
 */
function showHelp(commands: Map<string, Command>): void {
  console.log('Usage: npm start -- <command> [options]');
  console.log('');
  console.log('Available commands:');
  console.log('');

  for (const [name, command] of commands) {
    console.log(`  ${name.padEnd(20)} ${command.getDescription()}`);
  }

  console.log('');
  console.log('For command-specific help, run: npm start -- <command> --help');
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Discover all available commands
  const commands = await discoverCommands();

  // No command provided or help requested
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp(commands);
    return;
  }

  const commandName = args[0];
  const commandArgs = args.slice(1);

  // Check if command exists
  const command = commands.get(commandName);
  if (!command) {
    console.error(`✗ Unknown command: ${commandName}\n`);
    showHelp(commands);
    process.exit(1);
  }

  // Execute the command
  try {
    await command.execute(commandArgs);
  } catch (error) {
    console.error('Unhandled error:', error);
    process.exit(1);
  }
}

main();
