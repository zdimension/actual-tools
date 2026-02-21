import { chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { Connector } from '../connector.interface.js';
import { FetchTransactionsResult, VendorAccount, VendorTransaction } from '../../../../types.js';
import { EdenredPlusConfig } from './types.js';

const API_ROOT = 'https://prd.smarter.edenred.io/bff-user-api/v1';

interface EdenredPlusBenefit {
  benefitId: number;
  benefitName: string;
  availableAmount: number;
  currency: string;
}

interface EdenredPlusAccount {
  issuerAccountNumber: string;
  clientName: string;
  wallets: EdenredPlusBenefit[];
}

interface EdenredPlusTransaction {
  transactionId: string;
  name: string;
  type: 'REDEMPTION' | 'TOPUP';
  resultDetail: string;
  datetime: string;
  amount: number;
  currency: string;
  address?: {
    street?: string;
    postCode?: string;
    city?: string;
    country?: string;
  };
}

class EdenredPlusApi {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async fetch(endpoint: string): Promise<any> {
    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'x-tenant': 'FR',
      'x-correlation-id': 'f80930ce-a2f1-4c0d-aab7-e9fe122b7748',
      'Content-Type': 'application/json',
    };

    const response = await fetch(`${API_ROOT}/${endpoint}`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(`EdenredPlus API error: ${response.status} ${response.statusText}`);
    }

    const jsonResponse = await response.json();
    return (jsonResponse as any).data;
  }

  async getBenefits(): Promise<EdenredPlusAccount[]> {
    return await this.fetch('benefits');
  }

  async getTransactions(): Promise<EdenredPlusTransaction[]> {
    return await this.fetch('transactions');
  }
}

export class EdenredPlusConnector implements Connector {
  private async getToken(login: string, password: string, dataPath: string): Promise<string | null> {
    const userDataDir = path.join(dataPath, login);

    // Create data directory if it doesn't exist
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    const browser = await chromium.launchPersistentContext(path.join(userDataDir, "Chrome"), {
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
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

    let bearerToken: string | null = null;

    // Intercept requests to capture Bearer token
    page.on('request', (request) => {
      if (request.url().includes('prd.smarter.edenred.io')) {
        const authHeader = request.headers()['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
          bearerToken = authHeader.substring(7); // Remove "Bearer " prefix
          console.log('  ✓ Captured Bearer token from request');
        }
      }
    });

    console.log('  → Navigating to EdenredPlus...');
    await page.goto('https://user.edenredplus.com/#/home');

    // Wait for redirections to complete
    await page.waitForTimeout(3000);

    // Check if we're on the login page
    if (page.url().includes('sso.eu.edenred.io/web/session/step/password')) {
      console.log('  → Login required, filling credentials...');

      await page.waitForSelector('input#Username', { timeout: 10000 });
      await page.fill('input#Username', login);
      await page.fill('input#Password', password);
      await page.waitForTimeout(2000);

      const currentUrl = page.url();
      console.log('  → Waiting for user to submit login (and captcha if needed)...');
      let submitAttempts = 0;
      while (page.url() === currentUrl && submitAttempts < 60) {
        await page.waitForTimeout(1000);
        submitAttempts++;
        if (submitAttempts % 3 === 0) {
          console.log(`  ℹ Waiting for submit... (${submitAttempts}s, URL: ${page.url()})`);
        }
      }

      if (page.url() === currentUrl) {
        throw new Error('Login not submitted in time');
      }

      // Check if captcha validation failed
      const pageContent = await page.content();
      if (pageContent.includes('validation du captcha')) {
        throw new Error('Captcha validation failed - please try again later');
      }
    }

    // Check if OTP is required
    if (page.url().includes('sso.eu.edenred.io/web/session/step/otp')) {
      console.log('  ⚠ 2FA code required (SMS sent)');
      console.log('  → Waiting for user to complete OTP and submit...');

      const otpUrl = page.url();
      let otpAttempts = 0;
      while (page.url() === otpUrl && otpAttempts < 120) {
        await page.waitForTimeout(1000);
        otpAttempts++;
        if (otpAttempts % 3 === 0) {
          console.log(`  ℹ Waiting for OTP submit... (${otpAttempts}s, URL: ${page.url()})`);
        }
      }

      if (page.url() === otpUrl) {
        throw new Error('OTP not submitted in time');
      }
    }

    // Check if on trusted device page
    if (page.url().includes('sso.eu.edenred.io/web/session/step/trusted-device')) {
      console.log('  → Accepting trusted device...');

      const trustButton = await page.waitForSelector('#accept-trust-browser-btn', { timeout: 10000 });
      if (trustButton) {
        await trustButton.click();
      }

      await page.waitForTimeout(2000);
    }

    // Wait to be redirected back to home
    console.log('  → Waiting for redirect to home page...');
    let redirectAttempts = 0;
    while (!page.url().includes('user.edenredplus.com') && redirectAttempts < 30) {
      console.log(`  ℹ Current URL: ${page.url()}`);
      await page.waitForTimeout(1000);
      redirectAttempts++;
    }

    if (!page.url().includes('user.edenredplus.com')) {
      throw new Error('Failed to redirect to home page');
    }

    // Handle cookie banner if present
    try {
      const cookieButton = await page.waitForSelector('#didomi-notice-agree-button', { timeout: 2000 });
      if (cookieButton) {
        console.log('  → Accepting cookies...');
        await cookieButton.click();
        await page.waitForTimeout(500);
      }
    } catch (e) {
      // No cookie banner
    }

    // Wait for Bearer token to be captured
    let attempts = 0;
    while (!bearerToken && attempts < 30) {
      await page.waitForTimeout(1000);
      attempts++;
      if (attempts % 3 === 0) {
        console.log(`  ℹ Waiting for token... (${attempts}s, URL: ${page.url()})`);
      }
    }

    if (!bearerToken) {
      console.log('  ✗ Failed to capture Bearer token');
      await browser.close();
      return null;
    }

    console.log('  ✓ Successfully authenticated');
    await browser.close();
    return bearerToken;
  }

  async fetchTransactions(config: EdenredPlusConfig, dataPath: string): Promise<FetchTransactionsResult> {
    console.log('→ Authenticating with EdenredPlus...');
    const token = await this.getToken(config.login, config.password, dataPath);

    if (!token) {
      throw new Error('Failed to authenticate with EdenredPlus');
    }

    console.log('→ Fetching data from EdenredPlus API...');
    const api = new EdenredPlusApi(token);

    // Fetch benefits (accounts)
    const benefitsData = await api.getBenefits();

    if (benefitsData.length !== 1) {
      throw new Error(`Expected exactly 1 account, got ${benefitsData.length}`);
    }

    const accountData = benefitsData[0];

    if (accountData.wallets.length !== 1) {
      throw new Error(`Expected exactly 1 wallet, got ${accountData.wallets.length}`);
    }

    const wallet = accountData.wallets[0];

    if (wallet.benefitId !== 1) {
      throw new Error(`Expected benefitId to be 1, got ${wallet.benefitId}`);
    }

    // Parse account
    const account: VendorAccount = {
      vendorId: '1',
      name: `${accountData.clientName} - ${wallet.benefitName}`,
      balance: wallet.availableAmount,
      institutionLabel: 'EdenredPlus',
    };

    // Fetch transactions
    const transactionsData = await api.getTransactions();

    // Parse transactions
    const transactions: VendorTransaction[] = transactionsData.map((tx) => {
      // Validate transaction type
      if (tx.type !== 'REDEMPTION' && tx.type !== 'TOPUP') {
        throw new Error(`Unsupported transaction type: ${tx.type}`);
      }

      // Validate result
      if (tx.resultDetail !== 'SUCCESSFUL') {
        throw new Error(`Transaction ${tx.transactionId} is not SUCCESSFUL: ${tx.resultDetail}`);
      }

      // Validate currency
      if (tx.currency !== 'EUR') {
        throw new Error(`Unsupported currency: ${tx.currency}`);
      }

      // Calculate amount (negative for REDEMPTION, positive for TOPUP)
      const amount = tx.type === 'REDEMPTION' ? -tx.amount : tx.amount;

      const addressParts = [
        tx.address?.street,
        tx.address?.city,
        tx.address?.postCode,
        tx.address?.country,
      ].filter((part) => part && part.trim().length > 0) as string[];

      const payee = addressParts.length > 0
        ? `${tx.name} - ${addressParts.join(', ')}`
        : tx.name;

      return {
        vendorId: tx.transactionId,
        vendorAccountId: '1',
        amount: amount,
        date: tx.datetime.split('T')[0],
        label: payee,
        originalLabel: payee,
      };
    });

    console.log(`  ✓ Found ${1} account and ${transactions.length} transaction(s)`);

    return {
      accounts: [account],
      transactions,
    };
  }
}
