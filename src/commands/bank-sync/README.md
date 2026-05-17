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

Your connector must handle the login process and can signal that a 2FA has been required by throwing `TwoFactorRequiredError`. The bank-sync command will disable the connector temporarily and inform the user.

## Transaction Format

Your connector will return transactions in this format (see types.ts for details):

```js
interface VendorTransaction {
  vendorId: string; // Unique ID from the connector
  vendorAccountId: string; // Account ID this transaction belongs to
  date: string; // YYYY-MM-DD
  amount: number; // Amount in cents (or smallest currency unit)
  label: string; // Description/payee
  originalLabel?: string; // Raw bank description
}
```

They will be sent to Actual Budget in this format:
- `date`: YYYY-MM-DD
- `amount`: Integer (cents)
- `imported_payee`: Original bank description
- `imported_id`: `{connector}/{accountId}/{transactionId}` (prevents duplicates)