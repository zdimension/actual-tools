# actual-tools

Collection of tools for [Actual Budget](https://github.com/actualbudget/actual).

I started making this after [Cozy Banks](https://github.com/cozy/cozy-banks) was deprecated. I needed to port my many connectors and analysis tools from Python & Cozy to JS & Actual. For that reason, a lot of the code here has been written by LLMs in Agent mode -- seriously, it works amazingly well. I gave it my original code and guided it through an architecture plan, step by step, and the result is nice. All of the LLM-generated code is of course human-reviewed, but it did save me quite a lot of time.

## Setup

```bash
npm install
```

## Recommandations for bank sync

There are a lot of solutions out there that use the Open Banking APIs to sync your bank accounts but most of them either only support checkings accounts (no savings) or have severe limitations on their free plans.

I have been using Bankin which supports a lot of banks and includes savings accounts. Of course, they have your data, but that's life in 2026. This repo contains a few other manually implemented connectors:

- Amundi investment
- BNP ERE
- Bourse Direct
- Edenred+
- MyEdenred (deprecated)
- WiiSmile

## Configuration

Edit `config.json`:

```json
{
  "clientId": "arbitrary-client-id",
  "clientSecret": "arbitrary-client-secret",
  "startCutoff": "2024-01-01",
  "balanceUpdate": {
    "categoryId": "uuid-for-balance-update",
    "frequencyDays": 7
  },
  "interestCategory": "uuid-for-interest-transactions",
  "actual": {
    "url": "https://your-actual-server.com",
    "password": "your-actual-password",
    "syncId": "your-budget-sync-id"
  },
  "connectors": {
    "bankin": {
      "foobar": {
        "email": "your-bankin-email",
        "password": "your-bankin-password",
        "startCutoff": "2025-01-01",
        "accountMapping": {}
      }
    }
  }
}
```

### Configuration Options

- **`startCutoff`** (optional, global): Date in YYYY-MM-DD format. Only transactions on or after this date will be imported. Useful for initial import to avoid importing years of historical data.
- **`connectors.{connector}.startCutoff`** (optional): Connector-specific date cutoff that overrides the global `startCutoff` for that connector.
 - **`clientId` / `clientSecret`** (optional): Used for connectors that require API authentication (e.g. Bankin). These can be set globally or per-connector if needed.
 - **`balanceUpdate`** (optional): Configuration used for investment accounts sync to create balance-adjustment transactions. Includes `categoryId` (Actual category UUID) and `frequencyDays` (minimum days between automatic balance updates).
 - **`interestCategory`** (optional): Category UUID used to mark interest/dividend transactions for yield analysis.
 - **`connectors`**: Connector entries are grouped by connector name and then by account nickname. Example: `"connectors": { "bankin": { "foobar": { ... } } }`. Each account object may contain connector-specific fields (e.g. `login` / `email`, `password`, `otpUrl`), plus `accountMapping`, `startCutoff`, and `disabled`.

## Usage

### Command-Line Options

```bash
npm start -- the-command --arg1 val1
```

### Scratch scripts (ActualQL / custom code)

You can run any JS/TS script file directly through the app runtime:

```bash
npm start -- src/scratch/thing1.js
```

This will:
- load `config.json`
- initialize Actual API + budget
- dynamically import and run your script
- shutdown Actual cleanly afterwards

Script module contract:
- export a default async function `(ctx) => { ... }`, or
- export named `run` async function

The `ctx` object includes:
- `actualClient` (wrapper used by built-in commands)
- `api` from `@actual-app/api` (includes `q`, `runQuery`, etc.)
- `utils` from `@actual-app/api`
- `config`, `configManager`, `args`, `cwd`

Pass custom script args after the file path:

```bash
npm start -- src/scratch/thing1.js --foo bar
```

Inside your script, read them from `ctx.args`.

## Commands

Below is an overview of the built-in commands and the most-used flags. For command-specific help run `npm start -- <command> --help`.

Available commands:

- **bank-sync**: Sync bank transactions from configured connectors.
- **list-accounts**: List Actual Budget accounts.
- **list-categories**: List categories grouped by parent group.
- **plot-balance**: Plot account balance history and open in browser.
- **sankey**: Show account flows as a Sankey diagram.
- **yield-analysis**: Compute XIRR / yield analysis for investment and savings accounts.
- **fix-transfers**: Find transfers between accounts owned by different owners.
- **import-cozy-balances**: Import balance history from Cozy.

### Bank sync quick start

```bash
npm start -- bank-sync [options]
```

Options:

- `-s`, `--summary` : Show summary of configured connectors and exit (no syncing).
- `-d`, `--dry-run` : Run without making any changes to Actual (safe test mode).
- `-c`, `--connectors <list>` : Comma-separated list of connectors to run. Format: `connector` (all accounts) or `connector/account` (specific account). Example: `-c bankin` or `-c bankin/foobar`.
- `-m`, `--all-manual` : Run all connectors marked as `requiresManualRun: true`.

Running without a connector specification will run all connectors that are not marked as `requiresManualRun: true`.

Examples:

```bash
# Show connector summary
npm start -- bank-sync -s

# Dry-run full sync
npm start -- bank-sync -d

# Run all accounts from a specific connector
npm start -- bank-sync -c bankin

# Run a specific connector account
npm start -- bank-sync -c bankin/foobar

# Run all manual connectors
npm start -- bank-sync -m
```

The tool will add any unmapped vendor accounts to `config.json` under the relevant connector/account's `accountMapping` with a `**` prefix to indicate they need attention. For each unmapped account you can:

- Replace `**` with an Actual account ID (UUID) to map to an existing account.
- Replace the value with `"new"` to automatically create a new Actual account.
- Leave the `**` prefix to skip the account.

Subsequent runs:

- Accounts mapped to UUIDs: Transactions imported directly
- Accounts mapped to `"new"`: Account created, then transactions imported (mapping updated with new UUID)
- Accounts with `**` prefix: Skipped with warning
- Accounts mapped to `""`: Skipped with warning

## Account Mapping Examples

```json
"accountMapping": {
  "12345": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",  // Existing Actual account
  "67890": "new",                                     // Will create new account
  "11111": ""                                         // Will skip
}
```

## Project Structure

```
src/
├── index.ts                 # Main orchestrator
├── types.ts                 # TypeScript type definitions
├── config-manager.ts        # Config file management
├── actual-client.ts         # Actual API wrapper
└── connectors/
    ├── connector.interface.ts  # Connector contract
    └── bankin/
        └── index.ts         # Bankin connector implementation
```

## License

MIT
