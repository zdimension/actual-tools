# actual-tools

Collection of tools for [Actual Budget](https://github.com/actualbudget/actual).

I started making this after [Cozy Banks](https://github.com/cozy/cozy-banks) was deprecated. I needed to port my many connectors and analysis tools from Python & Cozy to JS & Actual. For that reason, a lot of the code here has been writing by Copilot in Agent mode -- seriously, it works amazingly well. I gave it my original code and guided it through an architecture plan, step by step, and the result is nice.

## Setup

```bash
npm install
```

## Configuration

Edit `config.json`:

```json
{
  "client_id": "arbitrary-client-id",
  "client_secret": "arbitrary-client-secret",
  "startCutoff": "2024-01-01",
  "actual": {
    "url": "https://your-actual-server.com",
    "password": "your-actual-password",
    "syncId": "your-budget-sync-id"
  },
  "connectors": {
    "bankin": {
      "email": "your-bankin-email",
      "password": "your-bankin-password",
      "startCutoff": "2025-01-01",
      "accountMapping": {}
    }
  }
}
```

### Configuration Options

- **`startCutoff`** (optional, global): Date in YYYY-MM-DD format. Only transactions on or after this date will be imported. Useful for initial import to avoid importing years of historical data.
- **`connectors.{connector}.startCutoff`** (optional): Connector-specific date cutoff that overrides the global `startCutoff` for that connector.

## Usage

### Command-Line Options

```bash
npm start -- the-command --arg1 val1
```

## Commands

### Bank sync

1. Build and run:
   ```bash
   npm run build
   npm start
   ```

2. The tool will find unmapped accounts and add them to `config.json`:
   ```json
   "accountMapping": {
     "12345": "**Account Name",
     "67890": "**Another Account"
   }
   ```

3. For each account, either:
   - Replace `**` with an Actual account ID (UUID) to map to an existing account
   - Replace `**` with `"new"` to automatically create a new account
   - Leave the `**` prefix to skip the account

### Subsequent Runs

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

## Adding New Connectors

1. Create a new directory: `src/connectors/{connector-name}/`
2. Implement the `Connector` interface:
   ```typescript
   import { Connector } from '../connector.interface.js';
   
   export class MyConnector implements Connector {
     async fetchTransactions(config, dataPath) {
       // Your implementation
     }
   }
   ```
3. Register in `src/index.ts` in the `getConnector()` function

## Transaction Format

Transactions are formatted with these required fields:
- `date`: YYYY-MM-DD
- `amount`: Integer (cents)
- `imported_payee`: Original bank description
- `imported_id`: `{connector}/{accountId}/{transactionId}` (prevents duplicates)

## License

MIT
