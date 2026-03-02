import axios, { AxiosInstance } from 'axios';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Connector } from '../connector.interface.js';
import {
  FetchTransactionsResult,
  VendorAccount,
  VendorTransaction,
} from '../../../../types.js';
import { Config } from './types.js';

interface BankinDeviceData {
  bankinDeviceId?: string;
}

interface BankinAccount {
  id: number;
  name: string;
  balance: number;
  bank: {
    id: number;
    name: string;
  };
}

interface BankinTransaction {
  id: number;
  description: string;
  raw_description: string;
  date: string;
  amount: number;
  currency_code: string;
  is_future?: boolean;
  account: {
    id: number;
  };
}

interface BankinBank {
  id: number;
  name: string;
}

/**
 * Bankin connector implementation
 */
export class BankinConnector implements Connector {
  private clientId: string;
  private clientSecret: string;
  private email: string;
  private password: string;
  private baseUrl: string = 'https://sync.bankin.com';
  private bankinVersion: string = '2019-08-22';
  private accessToken: string = '';
  private bankinDeviceId: string = '';
  private banks: Record<number, BankinBank> = {};
  private axios: AxiosInstance;

  constructor(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.email = '';
    this.password = '';
    
    this.axios = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
    });
  }

  private formatAxiosError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const statusText = error.response?.statusText;
      const responseData = error.response?.data;
      const responseInfo = status ? `status ${status}${statusText ? ` ${statusText}` : ''}` : 'no response status';
      const dataText = responseData ? ` response=${JSON.stringify(responseData)}` : '';
      return `${error.message} (${responseInfo})${dataText}`;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  /**
   * Main entry point for fetching transactions
   */
  async fetchTransactions(
    config: Config,
    dataPath: string,
    isManuallyRun?: boolean
  ): Promise<FetchTransactionsResult> {
    if (!config.email?.trim()) {
      throw new Error('Bankin connector requires a non-empty email');
    }
    if (!config.password?.trim()) {
      throw new Error('Bankin connector requires a non-empty password');
    }

    this.email = config.email;
    this.password = config.password;

    // Load device ID if it exists
    await this.loadDeviceData(dataPath);

    // Initialize session
    await this.init();

    // Save device ID for future use
    await this.saveDeviceData(dataPath);

    // Fetch accounts
    console.log('Fetching accounts from Bankin...');
    const accounts = await this.fetchAccounts();
    console.log(`✓ Found ${accounts.length} accounts`);

    // Fetch transactions for all accounts
    console.log('Fetching transactions...');
    const allTransactions = await this.fetchAllTransactions(accounts);
    console.log(`✓ Found ${allTransactions.length} transactions`);

    return {
      accounts,
      transactions: allTransactions,
    };
  }

  /**
   * Initialize the Bankin API session
   */
  private async init(): Promise<void> {
    if (!this.bankinDeviceId) {
      console.log('Generating device ID...');
      await this.generateDeviceId();
      console.log('✓ Device ID generated');
    }

    console.log('Authenticating...');
    await this.authenticate();
    console.log('✓ Authenticated');

    console.log('Fetching banks directory...');
    await this.fetchBanks();
    console.log(`✓ Loaded ${Object.keys(this.banks).length} banks`);
  }

  /**
   * Generate a device ID for Bankin API
   */
  private async generateDeviceId(): Promise<void> {
    try {
      const response = await this.axios.post('/v2/devices', {
        os: 'android',
        version: '36',
        width: 1080,
        height: 2179,
        model: 'googlepixel7pro',
        has_fingerprint: false,
      }, {
        params: {
          client_id: this.clientId,
          client_secret: this.clientSecret,
        },
        headers: {
          'bankin-version': this.bankinVersion,
        },
      });

      this.bankinDeviceId = response.data.udid;
    } catch (error) {
      throw new Error(`Failed to generate device ID: ${this.formatAxiosError(error)}`);
    }
  }

  /**
   * Authenticate with Bankin API
   */
  private async authenticate(): Promise<void> {
    try {
      const csrfToken = createHash('md5')
        .update(`${this.email}${this.bankinDeviceId}`)
        .digest('base64');
      const response = await this.axios.post('/v2/authenticate', {
        email: this.email,
        password: this.password,
      }, {
        headers: {
          'Client-Id': this.clientId,
          'Client-Secret': this.clientSecret,
          'Bankin-Version': this.bankinVersion,
          'Bankin-Device': this.bankinDeviceId,
          'User-Agent': 'AndroidUserAgent-4.65.2-381-prod-Android_36-GooglePixel7Pro_1080_2340-standard-fr-',
          //'Csrf': csrfToken,
          'content-type': 'application/json;charset=UTF-8'
        },
      });

      this.accessToken = response.data.access_token;
    } catch (error) {
      throw new Error(`Authentication failed: ${this.formatAxiosError(error)}`);
    }
  }

  /**
   * Fetch banks directory
   */
  private async fetchBanks(): Promise<void> {
    try {
      const response = await this.axios.get('/v2/banks', {
        params: {
          client_id: this.clientId,
          client_secret: this.clientSecret,
          limit: 200,
        },
        headers: {
          'bankin-version': this.bankinVersion,
        },
      });

      this.banks = this.formatBanks(response.data.resources);
    } catch (error) {
      throw new Error(`Failed to fetch banks: ${this.formatAxiosError(error)}`);
    }
  }

  /**
   * Format banks directory into a lookup map
   */
  private formatBanks(countries: any[]): Record<number, BankinBank> {
    const banks: Record<number, BankinBank> = {};

    countries.forEach(country => {
      country.parent_banks?.forEach((parentBank: any) => {
        parentBank.banks?.forEach((bank: any) => {
          banks[bank.id] = {
            id: bank.id,
            name: bank.name,
          };
        });
      });
    });

    return banks;
  }

  /**
   * Fetch all accounts
   */
  private async fetchAccounts(): Promise<VendorAccount[]> {
    try {
      const response = await this.axios.get('/v2/accounts', {
        params: {
          client_id: this.clientId,
          client_secret: this.clientSecret,
          limit: 200,
        },
        headers: {
          'bankin-version': this.bankinVersion,
          authorization: `Bearer ${this.accessToken}`,
        },
      });

      return this.formatAccounts(response.data.resources);
    } catch (error) {
      throw new Error(`Failed to fetch accounts: ${this.formatAxiosError(error)}`);
    }
  }

  /**
   * Format accounts into standard format
   */
  private formatAccounts(accounts: BankinAccount[]): VendorAccount[] {
    return accounts.map(account => {
      const bankName = this.banks[account.bank.id]?.name || 'Unknown Bank';

      return {
        vendorId: String(account.id),
        name: account.name,
        balance: account.balance,
        institutionLabel: bankName,
      };
    });
  }

  /**
   * Fetch transactions for all accounts
   */
  private async fetchAllTransactions(accounts: VendorAccount[]): Promise<VendorTransaction[]> {
    const allRawTransactions: BankinTransaction[] = [];

    for (const account of accounts) {
      const transactions = await this.fetchTransactionsForAccount(account.vendorId);
      allRawTransactions.push(...transactions);
    }

    // Filter out future transactions and transactions after today
    const today = new Date().toISOString().split('T')[0];
    const filteredRaw = allRawTransactions.filter(t => !t.is_future && t.date <= today);

    // Now format the filtered transactions
    return this.formatTransactions(filteredRaw);
  }

  /**
   * Fetch transactions for a specific account
   */
  private async fetchTransactionsForAccount(accountId: string): Promise<BankinTransaction[]> {
    const transactions: BankinTransaction[] = [];
    let nextUrl: string | null = `/v2/accounts/${accountId}/transactions`;

    try {
      while (nextUrl) {
        const response: any = await this.axios.get(nextUrl, {
          params: nextUrl === `/v2/accounts/${accountId}/transactions` ? {
            client_id: this.clientId,
            client_secret: this.clientSecret,
            limit: 200,
          } : undefined,
          headers: {
            'bankin-version': this.bankinVersion,
            authorization: `Bearer ${this.accessToken}`,
          },
        });

        transactions.push(...response.data.resources);

        // Check for pagination
        nextUrl = response.data.pagination?.next_uri || null;
      }
    } catch (error) {
      throw new Error(`Failed to fetch transactions for account ${accountId}: ${this.formatAxiosError(error)}`);
    }

    return transactions;
  }

  /**
   * Format transactions into standard format
   */
  private formatTransactions(transactions: BankinTransaction[]): VendorTransaction[] {
    return transactions.map(transaction => ({
      vendorId: String(transaction.id),
      vendorAccountId: String(transaction.account.id),
      date: transaction.date,
      amount: transaction.amount,
      label: transaction.description,
      originalLabel: transaction.raw_description,
    }));
  }

  /**
   * Load device data from disk
   */
  private async loadDeviceData(dataPath: string): Promise<void> {
    const filePath = path.join(dataPath, 'device.tson');
    
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const deviceData: BankinDeviceData = JSON.parse(data);
      this.bankinDeviceId = deviceData.bankinDeviceId || '';
    } catch (error) {
      // File doesn't exist, that's okay
      this.bankinDeviceId = '';
    }
  }

  /**
   * Save device data to disk
   */
  private async saveDeviceData(dataPath: string): Promise<void> {
    const filePath = path.join(dataPath, 'device.tson');
    
    try {
      // Ensure directory exists
      await fs.mkdir(dataPath, { recursive: true });
      
      const deviceData: BankinDeviceData = {
        bankinDeviceId: this.bankinDeviceId,
      };
      
      await fs.writeFile(filePath, JSON.stringify(deviceData, null, 2), 'utf-8');
    } catch (error) {
      console.error(`Warning: Could not save device data: ${error}`);
    }
  }
}
