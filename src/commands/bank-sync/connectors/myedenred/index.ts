import { chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { Connector } from '../connector.interface.js';
import { FetchTransactionsResult, VendorAccount, VendorTransaction } from '../../../../types.js';
import { MyEdenredConfig } from './types.js';

const API_ROOT = 'https://user.eu.edenred.io/v1/users';

interface EdenredAuthData {
  token: string;
  clientId: string;
  clientSecret: string;
}

interface EdenredWallet {
  product_ref: string;
  currency: string;
  total_balance: number;
  amount?: number;
}

interface EdenredCard {
  card_ref: string;
  class: string;
  account_ref: string;
  employer: {
    name: string;
  };
  wallets: EdenredWallet[];
  operations?: EdenredOperation[];
}

interface EdenredOperation {
  operation_ref: string;
  status: string;
  cleared_status: string;
  date: string;
  currency: string;
  outlet: {
    name: string;
  };
  card?: EdenredCard;
  transaction_details: {
    wallets: EdenredWallet[];
  };
}

class EdenredApi {
  private email: string;
  private token: string;
  private clientId: string;
  private clientSecret: string;

  constructor(email: string, { token, clientId, clientSecret }: EdenredAuthData) {
    this.email = email;
    this.token = token;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  private async fetch(url: string): Promise<any> {
    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'X-Client-Id': this.clientId,
      'X-Client-Secret': this.clientSecret,
    };

    const response = await fetch(`${API_ROOT}/${this.email}/${url}`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(`Edenred API error: ${response.status} ${response.statusText}`);
    }

    const jsonResponse = await response.json();
    return (jsonResponse as any).data;
  }

  async getCards(): Promise<EdenredCard[]> {
    return await this.fetch('cards?wallet_result_level=full');
  }

  async getOperations(card: EdenredCard): Promise<EdenredOperation[]> {
    const operations = await this.fetch(`accounts/${card.class}-${card.account_ref}/operations`);
    return operations.filter(
      (op: EdenredOperation) => op.status === 'success' && op.cleared_status === 'cleared'
    );
  }

  async getAllOperations(): Promise<EdenredCard[]> {
    const cards = await this.getCards();
    await Promise.all(
      cards.map(async (card) => {
        card.operations = await this.getOperations(card);
        for (const op of card.operations) {
          op.card = card;
        }
      })
    );
    return cards;
  }
}

export class MyEdenredConnector implements Connector {
  private async getClientTokens(): Promise<{ clientId: string; clientSecret: string }> {
    // Fetch main page to get the JS bundle URL
    const htmlContent = await fetch('https://www.myedenred.fr').then((res) => res.text());
    const jsUrlMatch = htmlContent.match(
      /<link rel="modulepreload" crossorigin href="(\/assets\/common\.[^"]*)">/
    );

    if (!jsUrlMatch) {
      throw new Error('Failed to find JS bundle URL');
    }

    const jsUrl = jsUrlMatch[1];

    // Fetch the JS bundle to extract client credentials
    const jsContent = await fetch(`https://www.myedenred.fr${jsUrl}`).then((res) => res.text());

    const clientIdKey = jsContent.match(/ClientId:([^,]*),/)?.[1];
    const clientSecretKey = jsContent.match(/ClientSecret:([^,]*),/)?.[1];

    if (!clientIdKey || !clientSecretKey) {
      throw new Error('Failed to find client credential keys');
    }

    const clientIdMatch = jsContent.match(new RegExp(`,${clientIdKey}="([^"]*)"`));
    const clientSecretMatch = jsContent.match(new RegExp(`,${clientSecretKey}="([^"]*)"`));

    const clientIdVal = clientIdMatch?.[1];
    const clientSecretVal = clientSecretMatch?.[1];

    if (!clientIdVal || !clientSecretVal) {
      throw new Error('Failed to extract client credentials');
    }

    return { clientId: clientIdVal, clientSecret: clientSecretVal };
  }

  private async getToken(login: string, password: string, dataPath: string): Promise<string | null> {
    const userDataDir = path.join(dataPath, login);

    // Create data directory if it doesn't exist
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    const browser = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      viewport: null,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    const page = await browser.newPage();

    // Disable webdriver flag
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    await page.goto('https://myedenred.fr/');
    await page.waitForTimeout(2000);

    // Handle cookie consent banner if present
    try {
      const acceptButton = await page.getByText('Tout accepter').first();
      if (await acceptButton.isVisible({ timeout: 2000 })) {
        console.log('  → Accepting cookies...');
        await acceptButton.click();
        await page.waitForTimeout(500);
      }
    } catch (e) {
      // No cookie banner, continue
    }

    await page.goto('https://myedenred.fr/connexion');
    await page.waitForTimeout(1000);
    await page.waitForLoadState('networkidle');

    // Check if already logged in
    try {
      console.log('  → Checking if already logged in...');
      await page.waitForSelector('#btn-profil-nav', { timeout: 5000 });
      console.log('  ✓ Already logged in');
    } catch (e) {
      console.log('  → Not logged in, proceeding with authentication...');

      // Navigate to login page if not there
      if (!page.url().includes('/connexion') && !page.url().includes('password') && !page.url().includes('otp')) {
        await page.goto('https://myedenred.fr/connexion');
      }

      // Handle cookie consent
      try {
        const acceptButton = await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 1000 });
        if (acceptButton) {
          console.log('  → Accepting cookies...');
          await acceptButton.click();
          await page.waitForLoadState('networkidle');
        }
      } catch (e) {
        // No cookie banner
      }

      console.log('  → On login page');

      // Check if on OTP page
      try {
        await page.waitForSelector('input.verifyotp-number', { timeout: 2000 });
        console.log('  ⚠ 2FA code required - please complete authentication manually');
      } catch (e) {
        // Not on OTP page, proceed with login
        await page.waitForSelector('input[name="Username"]', { timeout: 20000 });
        console.log('  → Filling credentials...');

        const form = await page.$('form');
        if (form) {
          const usernameInput = await form.$('input[name="Username"]');
          if (usernameInput) await usernameInput.type(login);

          const passwordInput = await form.$('input[name="Password"]');
          if (passwordInput) await passwordInput.type(password);

          await page.waitForTimeout(500);

          const submitButton = await form.$('button[type="submit"]');
          if (submitButton) await submitButton.click();

          await page.waitForSelector('input.verifyotp-number', { timeout: 20000 });
          console.log('  ⚠ 2FA code required - please complete authentication manually');
        }
      }

      // Wait for successful login (profile button appears)
      console.log('  → Waiting for authentication to complete...');
      await page.waitForSelector('#btn-profil-nav', { timeout: 0 });
    }

    console.log('  ✓ Logged in, extracting token...');

    // Extract bearer token from session storage
    const bearer = await page.evaluate(() => sessionStorage.getItem('access_token'));

    if (!bearer) {
      console.log('  ✗ Failed to get access token');
      await browser.close();
      return null;
    }

    console.log('  ✓ Successfully extracted access token');
    await browser.close();
    return bearer;
  }

  async fetchTransactions(config: MyEdenredConfig, dataPath: string): Promise<FetchTransactionsResult> {
    console.log('→ Getting client credentials...');
    const clientTokens = await this.getClientTokens();

    console.log('→ Authenticating with MyEdenred...');
    const token = await this.getToken(config.login, config.password, dataPath);

    if (!token) {
      throw new Error('Failed to authenticate with MyEdenred');
    }

    const authData: EdenredAuthData = {
      token,
      clientId: clientTokens.clientId,
      clientSecret: clientTokens.clientSecret,
    };

    console.log('→ Fetching data from Edenred API...');
    const api = new EdenredApi(config.login, authData);
    const cards = await api.getAllOperations();

    console.log('→ Parsing accounts and transactions...');

    // Parse accounts
    const accounts: VendorAccount[] = cards.map((card) => {
      const wallet = card.wallets.find((w) => w.product_ref === 'CTR_H');
      if (!wallet) {
        throw new Error(`No CTR_H wallet found for card ${card.card_ref}`);
      }

      return {
        vendorId: card.card_ref,
        name: card.employer.name,
        balance: wallet.total_balance / 100,
        institutionLabel: 'Edenred',
      };
    });

    // Parse transactions
    const transactions: VendorTransaction[] = cards.flatMap((card) => {
      return (card.operations || []).map((op) => {
        const wallet = op.transaction_details.wallets.find((w) => w.product_ref === 'CTR_H');
        if (!wallet) {
          throw new Error(`No CTR_H wallet found for operation ${op.operation_ref}`);
        }

        return {
          vendorId: op.operation_ref,
          vendorAccountId: card.card_ref,
          amount: wallet.amount! / 100,
          date: op.date.split('T')[0],
          label: op.outlet.name,
          originalLabel: op.outlet.name,
        };
      });
    });

    console.log(`  ✓ Found ${accounts.length} account(s) and ${transactions.length} transaction(s)`);

    return {
      accounts,
      transactions,
    };
  }
}
