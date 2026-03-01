import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { chromium } from 'playwright';
// @ts-ignore
import { JSDOM } from 'jsdom';
import { Connector } from '../connector.interface.js';
import { TwoFactorRequiredError } from '../two-factor-error.js';
import {
  FetchTransactionsResult,
  VendorAccount,
  VendorTransaction,
} from '../../../../types.js';
import { Config } from './types.js';

const BASE_URL = 'https://www.boursedirect.fr/fr';
const LOGIN_URL = `${BASE_URL}/login`;
const WALLET_URL = `${BASE_URL}/page/portefeuille`;
const API_ROOT = 'https://www.boursedirect.fr';

interface RawAccount {
  id: string;
  name: string;
  balance: number;
  valId: string;
}

interface RawOperation {
  id: string;
  date: string; // YYYY-MM-DD
  label: string;
  amount: number;
  account: string;
}

export class BourseDirectConnector implements Connector {
  async fetchTransactions(
    config: Config,
    dataPath: string
  ): Promise<FetchTransactionsResult> {
    if (!config.login?.trim()) {
      throw new Error('BourseDirect connector requires a non-empty login');
    }
    if (!config.password?.trim()) {
      throw new Error('BourseDirect connector requires a non-empty password');
    }

    const token = await this.getToken(config, dataPath);
    const [rawAccounts, rawOps] = await this.getBourseDirectData(token);

    const operations = this.parseOps(rawOps);

    // sort operations asc by date
    operations.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const accounts = this.parseAccounts(rawAccounts);

    return {
      accounts,
      transactions: operations,
    };
  }

  private async getToken(config: Config, dataPath: string): Promise<string> {
    const userDataDir = path.join(dataPath, config.login);
    await fs.mkdir(userDataDir, { recursive: true });

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
    });

    const page = await context.newPage();

    try {
      await page.goto(WALLET_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      const getTokenFromCookies = async (): Promise<string | null> => {
        const cookies = await context.cookies();
        const cookie = cookies.find(c => c.name === 'CAPITOL');
        return cookie?.value || null;
      };

      let token = await getTokenFromCookies();

      try {
        await page.waitForURL(WALLET_URL, { timeout: 1000 });
      } catch {
        // Not logged in
        try {
          await page.locator('#didomi-notice-agree-button').click({ timeout: 1000 });
        } catch {
          // ignore
        }

        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

        await page.getByPlaceholder('Identifiant').fill(config.login);
        await page.locator('input[type="password"]').fill(config.password);
        await page.keyboard.press('Enter');

        const start = Date.now();
        for (;;) {
          // Check for 2FA prompt by evaluating in page context
          const twoFaInfo = await page.evaluate(() => {
            const modal = (globalThis as any).document.getElementById('2FA-modal');
            if (!modal) return { visible: false };
            return {
              visible: modal.offsetParent !== null,
              exists: true
            };
          }).catch(() => ({ visible: false, exists: false }));

          console.log(`2FA modal check: exists=${twoFaInfo.exists}, visible=${twoFaInfo.visible}`);

          if (twoFaInfo.visible) {
            console.log('2FA modal detected!');
            
            if (config.otpUrl) {
              const otpCode = this.generateOTPFromUrl(config.otpUrl);
              console.log(`Generated OTP code: ${otpCode}`);
              
              // Check trusted checkbox if present
              try {
                await page.locator('#trusted').check({ timeout: 1000 });
              } catch {
                // Checkbox not present, continue
              }
              
              // Type the six digits into the code inputs
              const codeInputs = await page.locator('.code-input > input').all();
              for (let i = 0; i < otpCode.length && i < codeInputs.length; i++) {
                await codeInputs[i].fill(otpCode[i]);
              }
              
              // Click submit button
              await page.locator('#2FA-modal .buttons .primary').click();
            } else {
              throw new TwoFactorRequiredError();
            }
          }

          const newToken = await getTokenFromCookies();
          if (newToken && newToken !== token && !newToken.includes('-')) {
            token = newToken;
            break;
          }
          console.log('Waiting for login to complete...');
          await page.waitForTimeout(1000);
          if (Date.now() - start > 40000) {
            throw new Error('Login timeout');
          }
        }
      }

      if (!token) {
        throw new Error('Could not retrieve session token');
      }

      return token;
    } finally {
      await context.close();
    }
  }

  private async getBourseDirectData(token: string): Promise<[RawAccount[], RawOperation[]]> {
    const api = new BourseDirectApi(token);
    return await api.getData();
  }

  private parseAccounts(rawAccounts: RawAccount[]): VendorAccount[] {
    return rawAccounts.map(account => ({
      vendorId: account.id,
      name: account.name,
      balance: account.balance,
      institutionLabel: 'Bourse Direct',
      isInvestment: !account.id.endsWith('-especes'), // True for all accounts except the cash account
    }));
  }

  private parseOps(ops: RawOperation[]): VendorTransaction[] {
    return ops.map(op => ({
      vendorId: op.id,
      vendorAccountId: op.account,
      amount: op.amount,
      date: op.date,
      label: op.label,
      originalLabel: op.label,
    }));
  }

  private generateOTPFromUrl(otpUrl: string): string {
    // Parse otpauth:// URL to extract the secret
    // Format: otpauth://totp/issuer:account?secret=BASE32SECRET&...
    const url = new URL(otpUrl);
    const secret = url.searchParams.get('secret');
    
    if (!secret) {
      throw new Error('No secret found in otpauth URL');
    }

    // Decode base32 secret and generate TOTP code
    const buffer = this.base32Decode(secret);
    const now = Math.floor(Date.now() / 1000);
    const counter = Math.floor(now / 30); // 30-second window
    const code = this.generateTOTP(buffer, counter);
    
    return code.padStart(6, '0');
  }

  private base32Decode(str: string): Buffer {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits: number[] = [];
    
    for (const char of str.toUpperCase()) {
      const val = alphabet.indexOf(char);
      if (val === -1) throw new Error('Invalid base32 character');
      bits.push(...val.toString(2).padStart(5, '0').split('').map(Number));
    }

    const bytes: number[] = [];
    for (let i = 0; i < bits.length - bits.length % 8; i += 8) {
      bytes.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    }
    
    return Buffer.from(bytes);
  }

  private generateTOTP(secret: Buffer, counter: number): string {
    const counterBuffer = Buffer.alloc(8);
    
    for (let i = 7; i >= 0; i--) {
      counterBuffer[i] = counter & 0xff;
      counter >>= 8;
    }

    const hmac = crypto.createHmac('sha1', secret);
    hmac.update(counterBuffer);
    const digest = hmac.digest();
    const offset = digest[digest.length - 1] & 0xf;
    const code = (
      ((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff)
    ) % 1000000;

    return code.toString();
  }

  private pause(message: string): Promise<void> {
    return new Promise(resolve => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.question(`\n${message}\n`, () => {
        rl.close();
        resolve();
      });
    });
  }
}

class BourseDirectApi {
  private token: string;
  private headers: Headers;

  constructor(token: string) {
    this.token = token;

    const headers = new Headers();
    headers.append('Cookie', `CAPITOL=${token}`);
    headers.append('cache-control', 'no-cache');
    headers.append('pragma', 'no-cache');
    headers.append(
      'user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    this.headers = headers;
  }

  private makeRequestOptions(method: string, body: string | null = null) {
    return {
      method,
      headers: this.headers,
      redirect: 'follow' as const,
      body,
    };
  }

  private async fetch(url: string, method: string = 'GET', body: string | null = null): Promise<string> {
    const response = await fetch(
      `${API_ROOT}/${url}`,
      this.makeRequestOptions(method, body)
    );
    return await response.text();
  }

  async getData(): Promise<[RawAccount[], RawOperation[]]> {
    const data = await this.fetch('streaming/compteTempsReelCK.php?stream=0&nc=1');
    const parsed = parseData(data.substring("message='".length, data.length - 1));

    const id = parsed.portfolio[11];
    const accounts: RawAccount[] = [
      {
        id: `${id}-especes`,
        name: 'Espèces',
        balance: makeFloat(parsed.portfolio[3]),
        valId: 'especes',
      },
      ...parsed.assets.map((asset: any) => ({
        id: `${id}-${asset[0].replace(/[ .]/g, '-')}`,
        name: asset[0],
        balance: asset[1],
        valId: asset[6][0][1][0].split('=')[1].split('&')[0],
      })),
    ];

    const dataOp = await this.fetch('priv/new/historique-de-compte.php');
    const dom = new JSDOM(dataOp);
    const rows = dom.window.document.querySelectorAll('.datas tr[class]');

    const ops: RawOperation[] = [];

    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      const [d, m, y] = (cells[0]?.textContent || '').split('/');
      if (!d || !m || !y) continue;
      const isoDate = `${y}-${m}-${d}`;
      const link = cells[2]?.querySelector('a');
      const amount = makeFloat(cells[6]?.textContent || '0');
      const label = [
        (cells[3]?.textContent || '').trim(),
        (cells[2]?.textContent || '').trim(),
      ].join(' ');
      const opId = `${id}-${y}-${m}-${d}-${label.replace(/[ .]/g, '-')}-${Math.floor(amount)}`;

      if (link === null) {
        ops.push({
          id: opId,
          date: isoDate,
          label,
          amount,
          account: `${id}-especes`,
        });
      } else {
        ops.push({
          id: `${opId}-1`,
          date: isoDate,
          label,
          amount,
          account: `${id}-especes`,
        });
        const valId = link.href.split('=')[1].split('&')[0];
        let acc = accounts.find(a => a.valId === valId);
        if (!acc) {
          acc = accounts.find(a => a.valId === valId.replace(/-(?:.*)$/, ''));
          if (!acc) {
            throw new Error(`Could not find account for valId ${valId}`);
          }
        }
        ops.push({
          id: `${opId}-2`,
          date: isoDate,
          label,
          amount: -amount,
          account: acc.id,
        });
      }
    }

    return [accounts, ops];
  }
}

const originalColumns: Record<string, number> = {
  libelle: 0,
  valorisation: 5,
  pmvalues: 6,
  varPRU: 7,
  varVeille: 8,
  percent: 9,
};

function makeFloat(text: string): number {
  let cleaned = text.replace(/([^0-9,-])/i, '');
  cleaned = cleaned.replace(/,/i, '.');
  const rtnFloat = parseFloat(cleaned);
  return Number.isNaN(rtnFloat) ? 0.0 : rtnFloat;
}

function parseData(message: string) {
  if (message === 'NULL' || message === '') {
    return false;
  }

  const rtnData: any = [];
  rtnData['portfolio'] = [];
  rtnData['assets'] = [];
  let assetCount = 0;
  let newAsset = true;
  const data: any[] = message.split('|');
  const regs1 = /#/i;
  const regs2 = /\{/i;

  for (let i = 0; i < data.length; i++) {
    if (i === 0) {
      data[i] = data[i].split('{');
      rtnData['portfolio'] = data[i];
    } else if (data[i] === '1') {
      data[i] = 'END';
      newAsset = true;
      assetCount++;
    } else {
      if (regs1.test(data[i])) data[i] = data[i].split('#');

      if (typeof data[i] === 'object') {
        for (let j = 0; j < (data[i] as any).length; j++) {
          if (regs2.test((data[i] as any)[j])) (data[i] as any)[j] = (data[i] as any)[j].split('{');
        }
      }

      if (newAsset) {
        rtnData['assets'][assetCount] = [
          (data[i] as any)[originalColumns['libelle']],
          makeFloat((data[i] as any)[originalColumns['valorisation']]),
          makeFloat((data[i] as any)[originalColumns['pmvalues']]),
          makeFloat((data[i] as any)[originalColumns['varPRU']]),
          makeFloat((data[i] as any)[originalColumns['varVeille']]),
          makeFloat((data[i] as any)[originalColumns['percent']]),
          [data[i]],
        ];

        newAsset = false;
      } else {
        rtnData['assets'][assetCount][6].push(data[i]);
        if ((data[i] as any)[0] === 'Total') {
          rtnData['assets'][assetCount][2] = makeFloat(
            (data[i] as any)[originalColumns['pmvalues']]
          );
        }
      }
    }
  }

  return rtnData;
}
