import { chromium, Browser, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { Connector } from '../connector.interface.js';
import { FetchTransactionsResult, VendorAccount, VendorTransaction } from '../../../../types.js';
import { Config } from './types.js';

const BASE_URL = 'https://epargnant.amundi-tc.com';
const API_ROOT = `${BASE_URL}/api`;

interface AmundiOperation {
  idInstruction: string;
  idDispositif: string;
  idFonds: string;
  nomDispositif: string;
  nomFonds: string;
  nomEntreprise: string;
  dateComptabilisation: string;
  montantNet: number;
  libelleCommunication: string;
  statut: string;
}

interface AmundiFond {
  idFonds: string;
  libelleFonds: string;
  positions: {
    montantNet?: number;
    montantBrut?: number;
  };
}

interface AmundiDispositif {
  idProduit: string;
  nomEntreprise: string;
  libelleProduit: string;
  fonds: AmundiFond[];
}

interface AmundiData {
  [dispositifId: string]: {
    fonds: {
      [fondId: string]: {
        operations: AmundiOperation[];
        nom: string;
        balance_net?: number;
      };
    };
    nom: string;
    nomEntreprise?: string;
    libelleProduit?: string;
  };
}

class AmundiApi {
  private token: string;
  private email: string;

  constructor(email: string, token: string) {
    this.email = email;
    this.token = token;
  }

  private async fetch(url: string): Promise<any> {
    const headers = {
      'x-noee-authorization': this.token,
      'Content-Type': 'application/json',
    };

    const response = await fetch(`${API_ROOT}/${url}`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(`Amundi API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async getData(): Promise<AmundiData> {
    // Fetch all operations
    const rawData = await this.fetch(
      'individu/operations?metier=ESR&flagFiltrageWebSalarie=true&flagInfoOC=Y&filtreStatutModeExclusion=false&flagRu=true&offset=0'
    );

    // Filter out cancelled operations and organize by dispositif and fond
    const rawOps: AmundiOperation[] = rawData.operationsIndividuelles
      .flatMap((oi: any) => oi.instructions.filter((i: any) => i.statut !== 'ANNULE'));

    const dispositifs: AmundiData = {};

    // Organize operations by dispositif and fond
    for (const i of rawOps) {
      const disp = dispositifs[i.idDispositif] || (dispositifs[i.idDispositif] = {
        fonds: {},
        nom: i.nomDispositif,
        nomEntreprise: i.nomEntreprise,
      });
      const fond = disp.fonds[i.idFonds] || (disp.fonds[i.idFonds] = {
        operations: [],
        nom: i.nomFonds,
      });
      fond.operations.push(i);
    }

    // Fetch detailed information for each dispositif to get balances
    for (const [id, disp] of Object.entries(dispositifs)) {
      const dispData: AmundiDispositif = await this.fetch(`individu/produitsEpargne/idDispositif/${id}`);
      disp.nomEntreprise = dispData.nomEntreprise;
      disp.libelleProduit = dispData.libelleProduit;

      // Update balances for each fond
      for (const f of dispData.fonds) {
        const fond = disp.fonds[f.idFonds];
        if (fond) {
          fond.balance_net = f.positions.montantNet || 0;
        }
      }
    }

    return dispositifs;
  }
}

export class AmundiConnector implements Connector {
  private async getToken(login: string, password: string, dataPath: string): Promise<string | null> {
    const userDataDir = path.join(dataPath, login);

    // Create data directory if it doesn't exist
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    const browser = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
      ],
      viewport: null,
    });

    const page = await browser.newPage();

    // Disable webdriver flag
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    let accessToken: string | null = null;

    // Intercept API responses to get the token
    page.on('response', async (response) => {
      if (response.url().includes('individu/push')) {
        try {
          const text = await response.text();
          if (text) {
            const json = JSON.parse(text);
            if (json.token) {
              accessToken = json.token;
              console.log('  ✓ Got authentication token');
            }
          }
        } catch (e) {
          // Ignore JSON parse errors
        }
      }
    });

    const walletUrl = `${BASE_URL}/#/connexion`;
    await page.goto(walletUrl);

    // Wait for page to load
    await page.waitForTimeout(500);

    // Check if page loaded properly (retry if needed)
    let html = await page.content();
    let tries = 0;
    while (html.length < 2000 && tries < 5) {
      tries++;
      console.log('  ⟳ Refreshing page...');
      await page.reload();
      await page.waitForTimeout(5000);
      html = await page.content();
    }

    if (html.length < 2000) {
      console.log('  ✗ Failed to load page');
      await browser.close();
      return null;
    }

    await page.waitForTimeout(3000);

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

    // Perform login
    const identifiantInput = await page.$('input#identifiant');
    if (identifiantInput) {
      await identifiantInput.type(login);
      await page.waitForTimeout(500);

      const submitButton = await page.$('button[type="submit"]');
      if (submitButton) {
        await submitButton.click();
      }

      await page.waitForSelector('input[type="password"]', { timeout: 20000 });
      await page.waitForTimeout(500);

      const passwordInput = await page.$('input[type="password"]');
      if (passwordInput) {
        await passwordInput.type(password);
        await page.waitForTimeout(1500);

        const submitButton2 = await page.$('button[type="submit"]');
        if (submitButton2) {
          await submitButton2.click();
        }
      }
    }

    // Wait for token (up to 90 seconds)
    let count = 0;
    while (!accessToken && count < 90) {
      await page.waitForTimeout(1000);
      count++;
    }

    if (!accessToken) {
      console.log('  ✗ Failed to get authentication token');
      await browser.close();
      return null;
    }

    await browser.close();
    return accessToken;
  }

  private letterify(id: string): string {
    // Replace A by 00, B by 01, ..., Z by 25
    return id.replace(/[A-Z]/g, (c) => {
      return (c.charCodeAt(0) - 65).toString().padStart(2, '0');
    });
  }

  async fetchTransactions(config: Config, dataPath: string): Promise<FetchTransactionsResult> {
    if (!config.login?.trim()) {
      throw new Error('Amundi connector requires a non-empty login');
    }
    if (!config.password?.trim()) {
      throw new Error('Amundi connector requires a non-empty password');
    }

    console.log('→ Authenticating with Amundi...');
    const token = await this.getToken(config.login, config.password, dataPath);

    if (!token) {
      throw new Error('Failed to authenticate with Amundi');
    }

    console.log('→ Fetching data from Amundi API...');
    const api = new AmundiApi(config.login, token);
    const data = await api.getData();

    console.log('→ Parsing accounts and transactions...');

    // Parse accounts
    const accounts: VendorAccount[] = Object.entries(data).flatMap(([idDisp, disp]) => {
      return Object.entries(disp.fonds).map(([idFund, fund]) => {
        const fullId = this.letterify(`${idDisp}${idFund}`.replaceAll('-', ''));
        return {
          vendorId: fullId,
          name: `${disp.nomEntreprise} - ${disp.libelleProduit} - ${fund.nom}`,
          balance: fund.balance_net || 0,
          institutionLabel: 'Amundi',
          isInvestment: true, // Amundi accounts are investment accounts
        };
      });
    });

    // Parse transactions
    const transactions: VendorTransaction[] = Object.entries(data).flatMap(([idDisp, disp]) => {
      return Object.entries(disp.fonds).flatMap(([idFund, fund]) => {
        const fullId = this.letterify(`${idDisp}${idFund}`.replaceAll('-', ''));
        return fund.operations.map((op) => ({
          vendorId: op.idInstruction,
          vendorAccountId: fullId,
          amount: op.montantNet,
          date: op.dateComptabilisation,
          label: op.libelleCommunication,
          originalLabel: op.libelleCommunication,
        }));
      });
    });

    console.log(`  ✓ Found ${accounts.length} account(s) and ${transactions.length} transaction(s)`);

    return {
      accounts,
      transactions,
    };
  }
}
