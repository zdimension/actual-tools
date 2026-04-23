//import { chromium } from 'playwright';
import { chromium } from 'patchright';
import { Connector } from '../connector.interface.js';
import { TwoFactorRequiredError } from '../two-factor-error.js';
import {
  FetchTransactionsResult,
  VendorAccount,
  VendorTransaction,
} from '../../../../types.js';
import { Config } from './types.js';

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
const LOGIN_URL = `${API_ROOT}/wii_start`;
const WALLET_URL = `${API_ROOT}/beneficiary/wallets/`;

export class WiiSmileConnector implements Connector {
  async fetchTransactions(
    config: Config,
    dataPath: string,
    isManuallyRun: boolean = false
  ): Promise<FetchTransactionsResult> {
    if (!config.login?.trim()) {
      throw new Error('WiiSmile connector requires a non-empty login');
    }
    if (!config.password?.trim()) {
      throw new Error('WiiSmile connector requires a non-empty password');
    }

    const [phpsessid, datadome] = await this.getToken(config.login, config.password, dataPath, isManuallyRun);
    const cards = await this.getWiiSmileData(config.login, phpsessid, datadome);

    const accounts = this.parseAccounts(cards);
    const operations = this.parseOps(cards.flatMap(card => card.operations || []));

    return {
      accounts,
      transactions: operations,
    };
  }

  private async getToken(login: string, password: string, dataPath: string, isManuallyRun: boolean = false): Promise<[string, string]> {
    const userDataDir = `${dataPath}/${login}`;
    
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,/*isManuallyRun ? false : true,*/
      viewport: null,
      channel: "chrome"
      // args: ['--disable-blink-features=AutomationControlled'],
      // userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.25 Safari/537.36',
      // executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });

    const page = await context.newPage();

    try {
      await page.goto(WALLET_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      const hasCaptchaIframe = (await page.locator('iframe[title*="CAPTCHA"]').count()) > 0;
      if (hasCaptchaIframe) {
        if (isManuallyRun) {
          // Manual run: wait patiently for user to solve captcha
          console.log('⚠ Verification required detected. Please solve the captcha in the browser...');
          console.log('  Waiting for you to complete verification and reach the login page...');
          await page.waitForURL(LOGIN_URL, { timeout: 600000 }); // Wait up to 10 minutes

          await page.goto(WALLET_URL, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1000);
        } else {
          // Automatic run: throw error to disable connector
          const error = new TwoFactorRequiredError('Verification Required');
          error.reason = 'captcha';
          throw error;
        }
      }

      // Check if already logged in
      try {
        await page.waitForURL(WALLET_URL, { timeout: 4000 });
        console.log('✓ Already logged in');
      } catch {
        // Not logged in, need to authenticate
        console.log('Not logged in, logging in...');

        // Check if we're on the login page, if not navigate there
        if (!page.url().includes('/wii_start')) {
          await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1000);
        }
        
        // Fill in credentials
        await page.waitForSelector('form', { timeout: 1000 });
        await page.locator('input[name="username"]').fill(login);
        await page.waitForTimeout(500);
        await page.locator('input[name="password"]').fill(password);
        await page.waitForTimeout(1000);

        // Submit the form with action="/wii_start"
        await page.locator('form[action="/wii_start"]').evaluate((form: any) => form.submit());

        // Wait for successful login by checking URL change
        await page.waitForURL(WALLET_URL, { timeout: 400000 });
      }

      await page.waitForTimeout(2000);

      // Extract cookies
      const cookies = await context.cookies();
      const phpsessid = cookies.find(c => c.name === 'PHPSESSID')?.value || '';
      const datadome = cookies.find(c => c.name === 'datadome')?.value || '';

      if (!phpsessid || !datadome) {
        await page.waitForURL(LOGIN_URL, { timeout: 600000 }); // Wait up to 10 minutes
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
        date: op.date.split('T')[0],
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
    this.headers.append('sec-ch-ua-platform', '"Windows"');
    this.headers.append(
      'User-Agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
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
    // if response is not json, print it
    try {
      const res: any = await response.json();

      if (res.url) {
        console.error(`API response is probable 2FA block: ${JSON.stringify(res)}`);
        const error = new TwoFactorRequiredError('API returned 2FA URL');
        error.reason = '2fa';
        throw error;
      }
      return res;
    } catch {
      const text = await response.text();
      console.error('Failed to parse JSON response from WiiSmile API:');
      console.error(text);
      throw new Error('Invalid JSON response');
    }
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
