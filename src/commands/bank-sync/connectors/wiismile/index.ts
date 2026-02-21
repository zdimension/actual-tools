import { chromium } from 'playwright';
import { Connector } from '../connector.interface.js';
import {
  FetchTransactionsResult,
  VendorAccount,
  VendorTransaction,
} from '../../../../types.js';
import { WiiSmileConfig } from './types.js';

interface RawCard {
  id: string;
  category: {
    label: string;
  };
  amount: number;
  operations?: RawOperation[];
}

interface RawOperation {
  id: string;
  card: RawCard;
  amount: number;
  date: string;
  label: string;
  type: string;
}

const API_ROOT = 'https://monentreprise.wiismile.fr';
const WALLET_URL = `${API_ROOT}/beneficiary/wallets/`;

export class WiiSmileConnector implements Connector {
  async fetchTransactions(
    config: WiiSmileConfig,
    dataPath: string
  ): Promise<FetchTransactionsResult> {
    const [phpsessid, datadome] = await this.getToken(config.login, config.password, dataPath);
    const cards = await this.getWiiSmileData(config.login, phpsessid, datadome);

    const accounts = this.parseAccounts(cards);
    const operations = this.parseOps(cards.flatMap(card => card.operations || []));

    return {
      accounts,
      transactions: operations,
    };
  }

  private async getToken(login: string, password: string, dataPath: string): Promise<[string, string]> {
    const userDataDir = `${dataPath}/${login}`;
    
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.25 Safari/537.36',
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });

    const page = await context.newPage();

    try {
      await page.goto(WALLET_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000000);

      // Check if already logged in
      try {
        await page.waitForURL(WALLET_URL, { timeout: 4000 });
      } catch {
        // Not logged in, need to authenticate
        console.log('Not logged in, logging in...');
        
        // Fill in credentials
        await page.waitForSelector('form', { timeout: 1000 });
        await page.locator('input[name="username"]').fill(login);
        await page.waitForTimeout(500);
        await page.locator('input[name="password"]').fill(password);
        await page.waitForTimeout(1000);

        // Wait for successful login by checking URL change
        await page.waitForURL(WALLET_URL, { timeout: 400000 });
      }

      // Extract cookies
      const cookies = await context.cookies();
      const phpsessid = cookies.find(c => c.name === 'PHPSESSID')?.value || '';
      const datadome = cookies.find(c => c.name === 'datadome')?.value || '';

      if (!phpsessid || !datadome) {
        throw new Error('Failed to extract session cookies');
      }

      await context.close();
      return [phpsessid, datadome];
    } finally {
      await context.close();
    }
  }

  private async getWiiSmileData(email: string, phpsessid: string, datadome: string): Promise<RawCard[]> {
    const api = new WiiSmileApi(email, phpsessid, datadome);
    return await api.getAllOperations();
  }

  private parseAccounts(cards: RawCard[]): VendorAccount[] {
    return cards.map(card => ({
      vendorId: card.id,
      name: card.category.label,
      balance: card.amount,
      institutionLabel: 'WiiSmile',
    }));
  }

  private parseOps(ops: RawOperation[]): VendorTransaction[] {
    return ops
      .filter(op => op.type === 'operation')
      .map(op => ({
        vendorId: op.id,
        vendorAccountId: op.card.id,
        date: op.date,
        amount: op.amount,
        label: op.label,
        originalLabel: op.label,
      }));
  }
}

class WiiSmileApi {
  private email: string;
  private headers: Headers;

  constructor(email: string, phpsessid: string, datadome: string) {
    this.email = email;

    this.headers = new Headers();
    this.headers.append('Accept', 'application/json');
    this.headers.append('Accept-Language', 'fr');
    this.headers.append('Cache-Control', 'no-cache');
    this.headers.append('Connection', 'keep-alive');
    this.headers.append('Cookie', `PHPSESSID=${phpsessid}; datadome=${datadome}`);
    this.headers.append('Pragma', 'no-cache');
    this.headers.append(
      'User-Agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
  }

  private makeRequestOptions(method: string, body: string | null = null) {
    return {
      method,
      headers: this.headers,
      redirect: 'follow' as const,
      body,
    };
  }

  private async fetch(url: string, method: string = 'GET', body: string | null = null): Promise<any> {
    const response = await fetch(`${API_ROOT}/${url}`, this.makeRequestOptions(method, body));
    return await response.json();
  }

  async getCards(): Promise<RawCard[]> {
    return await this.fetch('beneficiary/wallets/load');
  }

  async getOperations(card: RawCard): Promise<RawOperation[]> {
    const result = await this.fetch(`beneficiary/wallets/${card.id}`);
    return result.filter((op: any) => op.type === 'operation');
  }

  async getAllOperations(): Promise<RawCard[]> {
    const cards = await this.getCards();
    console.log(`Got ${cards.length} cards`);

    await Promise.all(
      cards.map(async card => {
        card.operations = await this.getOperations(card);
        for (const op of card.operations) {
          op.card = card;
        }
      })
    );

    return cards;
  }
}
