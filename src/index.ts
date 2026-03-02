import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import * as api from '@actual-app/api';
import { utils } from '@actual-app/api';
import { Command } from './commands/command.interface.js';
import { ConfigManager } from './config-manager.js';
import { ActualClient } from './actual-client.js';
import { ScratchContext, ScratchScriptModule, ScratchScriptRunner } from './scratch-context.js';

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
  console.log('       npm start -- <path-to-script.js> [script-args...]');
  console.log('');
  console.log('Available commands:');
  console.log('');

  for (const [name, command] of commands) {
    console.log(`  ${name.padEnd(20)} ${command.getDescription()}`);
  }

  console.log('');
  console.log('For command-specific help, run: npm start -- <command> --help');
}

function looksLikeScriptPath(input: string): boolean {
  return input.includes('/') || input.includes('\\') || /\.(mjs|cjs|js|ts)$/i.test(input);
}

async function resolveScriptPath(input: string): Promise<string | null> {
  const directPath = path.resolve(process.cwd(), input);
  try {
    const stat = await fs.stat(directPath);
    if (stat.isFile()) {
      return directPath;
    }
  } catch {
    // Try fallback below
  }

  const distPath = path.resolve(process.cwd(), input.replace(/^src\//, 'dist/'));
  if (distPath !== directPath) {
    try {
      const stat = await fs.stat(distPath);
      if (stat.isFile()) {
        return distPath;
      }
    } catch {
      // no-op
    }
  }

  return null;
}

async function runScratchScript(scriptArg: string, scriptArgs: string[]): Promise<void> {
  const resolvedScriptPath = await resolveScriptPath(scriptArg);
  if (!resolvedScriptPath) {
    throw new Error(`Script file not found: ${scriptArg}`);
  }

  const configPath = path.join(process.cwd(), 'config.json');
  const configManager = new ConfigManager(configPath);

  await configManager.load();
  const config = configManager.getConfig();

  const actualClient = new ActualClient(config.actual);
  await actualClient.init();

  const context: ScratchContext = {
    actualClient,
    config,
    configManager,
    args: scriptArgs,
    api,
    utils,
    cwd: process.cwd(),
  };

  try {
    (globalThis as any).__ACTUAL_TOOLS_CONTEXT__ = context;

    const scriptUrl = pathToFileURL(resolvedScriptPath).href;
    const mod = (await import(scriptUrl)) as ScratchScriptModule;
    const runner: ScratchScriptRunner | undefined =
      typeof mod.default === 'function'
        ? mod.default
        : typeof mod.run === 'function'
          ? mod.run
          : undefined;

    if (runner) {
      await runner(context);
      return;
    }

    if (!mod.default && !mod.run) {
      return;
    }

    throw new Error(
      `Invalid scratch module: ${scriptArg}. Export either default async function(ctx) or named run(ctx).`
    );
  } finally {
    delete (globalThis as any).__ACTUAL_TOOLS_CONTEXT__;
    await actualClient.shutdown();
  }
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length > 0 && looksLikeScriptPath(args[0])) {
    const scriptArg = args[0];
    const scriptArgs = args.slice(1);

    try {
      await runScratchScript(scriptArg, scriptArgs);
      return;
    } catch (error) {
      console.error('Unhandled error:', error);
      process.exit(1);
    }
  }

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
