import { BaseCommand } from '../base-command.js';
import { ConfigManager } from '../../config-manager.js';
import { ActualClient } from '../../actual-client.js';
import { RootConfig } from '../../types.js';

interface TransferIssue {
  transactionId: string;
  date: string;
  amount: number;
  accountId: string;
  accountName: string;
  accountOwner: string;
  transferAccountId: string;
  transferAccountName: string;
  transferAccountOwner: string;
  payee: string;
}

export class FixTransfersCommand extends BaseCommand {
  getDescription(): string {
    return 'Find transfers between accounts of different owners';
  }

  async executeWithClients(configManager: ConfigManager, actualClient: ActualClient, config: RootConfig, args: string[]): Promise<void> {
    // Get all accounts
    const accounts = await actualClient.getAccounts();
    const accountMap = new Map<string, any>();
    
    for (const account of accounts) {
      if (!account.closed) {
        accountMap.set(account.id, account);
      }
    }

    console.log(`Found ${accountMap.size} open accounts\n`);

    // Get all transactions with transfers
    console.log('Analyzing transfers...\n');
    const issues: TransferIssue[] = [];
    const allTransactions = new Map<string, any>();

    // First pass: collect all transactions
    for (const account of accountMap.values()) {
      const transactions = await actualClient.getTransactions(account.id);
      for (const tx of transactions) {
        allTransactions.set(tx.id, { ...tx, accountId: account.id });
      }
    }

    console.log(`Found ${allTransactions.size} total transactions\n`);

    // Second pass: check transfers
    for (const tx of allTransactions.values()) {
      // Only check transactions that have a transfer_id
      if (!tx.transfer_id) continue;

      // Get the matching transfer transaction
      const transferTx = allTransactions.get(tx.transfer_id);
      if (!transferTx) continue;

      // Get both accounts
      const account = accountMap.get(tx.accountId);
      const transferAccount = accountMap.get(transferTx.accountId);
      
      if (!account || !transferAccount) continue;

      // Extract owner names (first word of account name)
      const accountOwner = this.extractOwner(account.name);
      const transferOwner = this.extractOwner(transferAccount.name);

      // Check if owners are different (only add once per transfer pair)
      if (accountOwner !== transferOwner && !issues.find(i => i.transactionId === tx.transfer_id)) {
        issues.push({
          transactionId: tx.id,
          date: tx.date,
          amount: tx.amount,
          accountId: account.id,
          accountName: account.name,
          accountOwner,
          transferAccountId: transferAccount.id,
          transferAccountName: transferAccount.name,
          transferAccountOwner: transferOwner,
          payee: tx.payee_name || tx.imported_payee || '(no payee)',
        });
      }
    }

    // Display results
    if (issues.length === 0) {
      console.log('✓ No transfers between different owners found');
    } else {
      console.log(`Found ${issues.length} transfer(s) between different owners:\n`);
      console.log('='.repeat(120));

      for (const issue of issues) {
        console.log(`Date: ${issue.date}`);
        console.log(`Amount: ${(issue.amount / 100).toFixed(2)}`);
        console.log(`Payee: ${issue.payee}`);
        console.log(`From: [${issue.accountOwner}] ${issue.accountName}`);
        console.log(`To:   [${issue.transferAccountOwner}] ${issue.transferAccountName}`);
        console.log(`Transaction ID: ${issue.transactionId}`);
        console.log('-'.repeat(120));
      }
    }
  }

  /**
   * Extract owner name from account name (first word before space)
   */
  private extractOwner(accountName: string): string {
    const firstWord = accountName.split(' ')[0];
    return firstWord || accountName;
  }
}
