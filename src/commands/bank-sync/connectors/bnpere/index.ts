import { chromium } from 'playwright';
import { Connector } from '../connector.interface.js';
import {
  FetchTransactionsResult,
  VendorAccount,
  VendorTransaction,
} from '../../../../types.js';
import { Config } from './types.js';

interface RawPlan {
  planID: string;
  name: string;
  company: string;
  totalAmount: number;
}

interface RawOperation {
  id: string;
  dateTime: string;
  label: string;
  amount: number;
  statusCode: string;
  company: string;
  planId: string;
  code: string;
}

const API_ROOT = 'https://monere-api.epargne-retraite-entreprises.bnpparibas.com/api/v1';
const BASE_URL = 'https://monepargne.ere.bnpparibas';
const WALLET_URL = `${BASE_URL}/accueil`;

export class BNPEREConnector implements Connector {
  async fetchTransactions(
    config: Config,
    dataPath: string,
    isManuallyRun?: boolean
  ): Promise<FetchTransactionsResult> {
    if (!config.login?.trim()) {
      throw new Error('BNPERE connector requires a non-empty login');
    }
    if (!config.password?.trim()) {
      throw new Error('BNPERE connector requires a non-empty password');
    }

    const token = await this.getToken(config.login, config.password, dataPath);
    const [plans, operations] = await this.getBNPEREData(config.login, token);

    const accounts = this.parseAccounts(plans);
    const transactions = this.parseOps(operations);

    return {
      accounts,
      transactions,
    };
  }

  private async getToken(login: string, password: string, dataPath: string): Promise<string> {
    const userDataDir = `${dataPath}/${login}`;
    
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
      viewport: null,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();
    let accessToken: string | null = null;

    // Intercept token from responses and requests
    page.on('response', async response => {
      const req = response.request();
      if (req.method() === 'OPTIONS') return;
      
      const authHeader = req.headers()['authorization'];
      if (authHeader && authHeader.includes(' ')) {
        accessToken = authHeader.split(' ')[1].trim();
      } else if (response.url().endsWith('/token')) {
        try {
          const json = await response.json();
          if (json.access_token) {
            accessToken = json.access_token;
          }
        } catch (e) {
          // ignore parse errors
        }
      }
    });

    try {
      await page.goto(WALLET_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      // Check if already logged in
      try {
        await page.waitForURL(WALLET_URL, { timeout: 5000 });
      } catch {
        // Not logged in, need to authenticate
        console.log('Not logged in, logging in...');

        // go to login page url
        //await page.goto("https://connexion.ere.bnpparibas/forms/connexion", { waitUntil: 'domcontentloaded' });
        
        // Handle cookies
        try {
          const onetrustBtns = page.locator('.save-preference-btn-handler');
          await page.waitForTimeout(500); // Give page time to load
          const count = await onetrustBtns.count();
          if (count > 0) {
            await onetrustBtns.first().click();
            await page.waitForTimeout(1000);
          }
        } catch (e) {
          // ignore
        }

        // Click login button
        console.log('Clicking login button...');
        await page.getByText('Je me connecte').first().click();
        await page.waitForTimeout(2000);

        // Fill in credentials
        // Check if email is already filled
        const emailInputs = await page.locator('input').all();
        let emailAlreadyFilled = false;
        
        for (const input of emailInputs) {
          try {
            const prevSibling = await input.evaluateHandle((el) => el.previousElementSibling);
            const text = await prevSibling.evaluate((el) => el?.textContent || '');
            if (text.includes('Adresse e-mail')) {
              const value = await input.inputValue();
              if (value && value.trim().length > 0) {
                emailAlreadyFilled = true;
                console.log('  → Email already filled, skipping');
                break;
              }
            }
          } catch (e) {
            // ignore
          }
        }
        
        if (!emailAlreadyFilled) {
          await page.locator('input[placeholder="Adresse e-mail"]').fill(login);
          await page.waitForTimeout(500);
        }
        
        await page.locator('input[type="password"]').fill(password);
        await page.waitForTimeout(500);

        // Click "Se souvenir" checkbox
        /*await page.locator('xpath=//div[contains(text(), "Se souvenir")]/parent::div/preceding-sibling::div/div/div').first().click();
        await page.waitForTimeout(2000);*/

        // Submit the form (press Enter)
        await page.locator('input[type="password"]').press('Enter');

        // Wait for login to complete
        try {
          await page.waitForURL(WALLET_URL, { timeout: 40000 });
        } catch (e) {
          // If URL contains oidc/callback, refresh and retry
          if (page.url().includes('oidc/callback')) {
            console.log('Refreshing after OIDC redirect...');
            await page.goto(WALLET_URL);
            // Try to get token with a retry
            await this.getToken(login, password, dataPath);
          }
          throw e;
        }
      }

      // Wait for token to be intercepted
      const maxRetries = 30;
      for (let i = 0; i < maxRetries; i++) {
        if (accessToken) {
          console.log('✓ Token obtained');
          await context.close();
          return accessToken;
        }
        await page.waitForTimeout(1000);
      }

      throw new Error('Failed to obtain access token');
    } finally {
      await context.close();
    }
  }

  private async getBNPEREData(email: string, token: string): Promise<[RawPlan[], RawOperation[]]> {
    const api = new BNPEREApi(email, token);
    const companies = await api.getCompanies();
    
    const plans = companies.flatMap((c: any) =>
      c.plans.map((p: any) => ({
        ...p,
        company: c.companyId,
      }))
    );

    const allOperations = (
      await Promise.all(
        companies.map((c: any) => api.getAllOperations(c.companyId))
      )
    ).flat();

    return [plans, allOperations];
  }

  private parseAccounts(plans: RawPlan[]): VendorAccount[] {
    return plans.map(plan => {
      const fullId = `${plan.company}999${plan.planID}`;
      return {
        vendorId: fullId,
        name: plan.name,
        balance: plan.totalAmount,
        institutionLabel: 'BNP Paribas Épargne Salariale',
        isInvestment: true,
      };
    });
  }

  private parseOps(ops: RawOperation[]): VendorTransaction[] {
    return ops.flatMap(op => {
      const fullId = `${op.company}999${op.planId}`;
      const isoDate = op.dateTime.split('T')[0]; // Extract YYYY-MM-DD from ISO string

      const result: VendorTransaction[] = [
        {
          vendorId: op.id,
          vendorAccountId: fullId,
          date: isoDate,
          amount: op.amount,
          label: op.label,
          originalLabel: op.label,
        },
      ];

      // For ARBITRAGE operations, create a reverse transaction
      if (op.code === 'ARBITRAGE') {
        result.push({
          vendorId: op.id + '11',
          vendorAccountId: fullId,
          date: isoDate,
          amount: -op.amount,
          label: op.label,
          originalLabel: op.label,
        });
      }

      return result;
    });
  }
}

class BNPEREApi {
  private token: string;
  private headers: Headers;

  constructor(email: string, token: string) {
    this.token = token;

    this.headers = new Headers();
    this.headers.append('Authorization', `Bearer ${token}`);
    this.headers.append('Content-Type', 'application/json');
    this.headers.append('x-api-version', '2.0.0');
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

  async getCompanies(): Promise<any[]> {
    const result = await this.fetch('companies');
    return result.companies || [];
  }

  async getAllOperations(company: string): Promise<RawOperation[]> {
    const allOps: RawOperation[] = [];
    let offsetRC = 0;
    let offsetES = 0;

    while (true) {
      const result = await this.fetch(
        `companies/${company}/operations?offsetRC=${offsetRC}&offsetES=${offsetES}&take=50`
      );

      if (!result.operations || result.operations.length === 0) {
        break;
      }

      // Filter for completed operations
      const completed = result.operations.filter((op: any) => op.statusCode === 'Termine');
      allOps.push(...completed);

      offsetRC = result.nextOffsetRC;
      offsetES = result.nextOffsetES;
    }

    // Fetch details for each operation to get the correct amount
    await Promise.all(
      allOps.map(async op => {
        const detail = await this.fetch(`companies/${company}/operations/detail/${op.id}`);
        op.company = company;
        op.planId = op.planId;
        
        if (detail.code === 'COMPTABLE_ABONDEMENT') {
          op.amount = detail.abundanceNetAmount;
        } else if (detail.code === 'TRANSFERT') {
          op.amount = detail.instructions?.[0]?.amountNet || op.amount;
        }
        
        op.code = detail.code;
      })
    );

    return allOps;
  }
}
