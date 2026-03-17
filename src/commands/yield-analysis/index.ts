import { createRequire } from 'module';
import { BaseCommand } from '../base-command.js';
import { ConfigManager } from '../../config-manager.js';
import { ActualClient } from '../../actual-client.js';
import { RootConfig } from '../../types.js';
import { xirr, RateInterval, convertRate } from 'node-irr';
// node-irr is CJS — use createRequire for reliable named-export access
/*const { xirr, convertRate, RateInterval } = createRequire(import.meta.url)('node-irr') as {
  xirr: (inputs: Array<{ amount: number; date: string | Date }>, options?: { estimate?: number }) => { days: number; rate: number };
  convertRate: (rate: number, to: string | number, from?: string | number) => number;
  RateInterval: { Year: string };
};*/

// ── Constants ─────────────────────────────────────────────────────────────────

/** Accounts whose name matches this are "investment" accounts (PEE / PEA). */
const STOCKS_RE = /PEE|PEA (?!Esp)/;

/**
 * Historical rates for the standard French regulated savings accounts.
 * Keys are ISO date strings indicating the start date for each rate.
 */
const RATES: Record<string, Record<string, number>> = {
  'Livret A': {
    '2023-02-01': 0.03,
    '2025-02-01': 0.024,
    '2025-08-01': 0.017,
    '2026-02-01': 0.015,
  },
  'Livret Jeune': {
    '2023-02-01': 0.04,
    '2026-02-01': 0.035
  },
  LEP: {
    '2023-08-01': 0.06,
    '2024-02-01': 0.05,
    '2024-08-01': 0.04,
    '2025-02-01': 0.035,
    '2025-08-01': 0.027,
    '2026-02-01': 0.025,
  },
};

// ── Half-month helpers ────────────────────────────────────────────────────────

/**
 * Encode a date as a "half-month" index.
 * Format: 24 * year + 2 * (month - 1) + (day > 15 ? 1 : 0) + 1
 * The second half of December has index 24*year + 24, which is 0 mod 24 —
 * this is when annual interest is credited for Livret A / LEP / Livret Jeune.
 */
function getHalfMonth(dateStr: string): number {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return 24 * y + 2 * (m - 1) + (d > 15 ? 1 : 0) + 1;
}

// ── Rate lookup factory ───────────────────────────────────────────────────────

type RateInput = number | Record<string, number>;

function makeGetRate(rateInput: RateInput): (hm: number) => number {
  if (typeof rateInput === 'number') {
    return () => rateInput as number;
  }
  // Descending sort so we can return the first entry whose date ≤ hm
  const entries: [number, number][] = Object.entries(rateInput)
    .map(([d, r]) => [getHalfMonth(d), r] as [number, number])
    .sort((a, b) => b[0] - a[0]);
  return (hm: number) => {
    for (const [d, r] of entries) {
      if (hm >= d) return r;
    }
    return entries[entries.length - 1][1]; // fallback to earliest known rate
  };
}

// ── Core computation ──────────────────────────────────────────────────────────

interface Op {
  date: string;
  amount: number; // euros (not cents)
}

/**
 * Simulate the "15-day block" interest calculation used by French regulated
 * savings accounts and compute the total interest generated up to `until`.
 *
 * Rules:
 *  - Interest accrues on the MINIMUM balance within each half-month period.
 *  - Rate is annual; each half-month earns `rate / 24`.
 *  - Accrued interest is credited to the balance at the end of December
 *    (hm % 24 === 0).
 */
function computeFinalBalance(rateInput: RateInput, accOps: Op[], until: number): number {
  if (accOps.length === 0) return 0;
  const getRate = makeGetRate(rateInput);
  let balance = 0;
  let interest = 0;
  let hm = getHalfMonth(accOps[0].date);
  let currentOp = 0;
  let totalInterest = 0;

  while (hm < until) {
    const rate = getRate(hm);
    let minBalance = balance;

    // Apply all operations in this half-month
    while (currentOp < accOps.length && getHalfMonth(accOps[currentOp].date) === hm) {
      balance += accOps[currentOp].amount;
      if (balance < minBalance) minBalance = balance;
      currentOp++;
    }

    const generated = minBalance * rate / 24;
    interest += generated;
    totalInterest += generated;

    // Credit accrued interest to balance at end of December (second half)
    if (hm % 24 === 0) {
      balance += interest;
      interest = 0;
    }

    hm++;
  }

  return totalInterest;
}

/**
 * Golden section search — find the x in [lo, hi] that minimises f(x).
 * Used to recover an "equivalent annual rate" from a known gain figure.
 */
function minimize1D(f: (x: number) => number, lo: number, hi: number, iters = 100): number {
  const phi = 1.618033988749895;
  let c = hi - (hi - lo) / phi;
  let d = lo + (hi - lo) / phi;
  for (let i = 0; i < iters; i++) {
    if (f(c) < f(d)) hi = d;
    else lo = c;
    c = hi - (hi - lo) / phi;
    d = lo + (hi - lo) / phi;
  }
  return (lo + hi) / 2;
}

/**
 * Compute the annualised XIRR for a list of cash-flows + current balance.
 * Convention: deposits into the investment (positive in Actual) become
 * *negative* for XIRR (money leaves your pocket), and the current balance
 * is the positive terminal cash-flow.
 */
function computeXirr(opsNoBalance: Op[], currentBalance: number): number {
  if (opsNoBalance.length === 0) return NaN;
  const today = new Date().toISOString().slice(0, 10);
  const inputs = [
    ...opsNoBalance.map(op => ({ amount: -op.amount, date: op.date })),
    { amount: currentBalance, date: today },
  ];
  try {
    const result = xirr(inputs, { estimate: 0.05 });
    return convertRate(result.rate, RateInterval.Year);
  } catch {
    return NaN;
  }
}

// ── Table renderer ────────────────────────────────────────────────────────────

type Row = (string | number)[] | typeof ROW_SEP;
const ROW_SEP = Symbol('separator');

function fmtCell(val: string | number, fmt: string): string {
  if (typeof val === 'string') return val;
  if (!isFinite(val)) return 'N/A';
  if (fmt.endsWith('%')) {
    const m = fmt.match(/\.(\d+)%/);
    return (val * 100).toFixed(m ? +m[1] : 1) + '%';
  }
  const m = fmt.match(/\.(\d+)f/);
  return val.toFixed(m ? +m[1] : 2);
}

function renderTable(headers: string[], rows: Row[], fmts: string[]): string {
  const dataRows = rows.filter(r => r !== ROW_SEP) as (string | number)[][];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...dataRows.map(r => fmtCell(r[i], fmts[i]).length))
  );
  const sep = widths.map(w => '-'.repeat(w)).join('  ');
  const fmtRow = (row: (string | number)[]) =>
    row.map((v, i) => {
      const s = fmtCell(v, fmts[i]);
      return i === 0 ? s.padEnd(widths[i]) : s.padStart(widths[i]);
    }).join('  ');

  const lines: string[] = [fmtRow(headers), sep];
  for (const row of rows) {
    lines.push(row === ROW_SEP ? sep : fmtRow(row as (string | number)[]));
  }
  return lines.join('\n');
}

// ── Command ───────────────────────────────────────────────────────────────────

export class YieldAnalysisCommand extends BaseCommand {
  getDescription(): string {
    return 'Compute IRR and yield analysis for investment and savings accounts';
  }

  async executeWithClients(
    _configManager: ConfigManager,
    actualClient: ActualClient,
    config: RootConfig,
    _args: string[]
  ): Promise<void> {
    const balanceCategoryId = config.balanceCategory;
    const interestCategoryId = config.interestCategory;

    if (!balanceCategoryId) throw new Error('config.balanceCategory is not set');
    if (!interestCategoryId) throw new Error('config.interestCategory is not set');

    const today = new Date().toISOString().slice(0, 10);
    const curYear = new Date().getFullYear();
    const HM_NOW = getHalfMonth(today) + 1;
    const END_OF_YEAR = getHalfMonth(`${curYear}-12-31`) + 1;
    const YEAR_START = `${curYear}-01-01`;
    const PREV_YEAR_END = `${curYear - 1}-12-31`;

    // ── Fetch and classify accounts ───────────────────────────────────────────
    const accounts: any[] = (await actualClient.getAccounts()).filter((a: any) => !a.closed);

    const investmentAccounts = accounts.filter((a: any) => STOCKS_RE.test(a.name));

    // Each savings account may match multiple rate categories (rare but mirrored from Python)
    const savingsEntries: Array<{ account: any; rateHist: Record<string, number> }> = [];
    for (const acc of accounts) {
      for (const [rateName, rateHist] of Object.entries(RATES)) {
        if (acc.name.includes(rateName)) {
          savingsEntries.push({ account: acc, rateHist });
        }
      }
    }

    // ── Per-account data cache ────────────────────────────────────────────────
    interface AccData {
      ops: Op[];          // all transactions
      opsNoBalance: Op[]; // transactions NOT in balanceCategory
      balance: number;    // current balance in euros
    }
    const cache = new Map<string, AccData>();

    const processAccount = async (acc: any): Promise<AccData> => {
      if (cache.has(acc.id)) return cache.get(acc.id)!;

      const txs: any[] = await actualClient.getTransactions(acc.id);
      // Sort by date, then amount — mirrors Python's sort key
      txs.sort((a: any, b: any) => a.date.localeCompare(b.date) || a.amount - b.amount);

      const ops: Op[] = txs.map((tx: any) => ({ date: tx.date, amount: tx.amount / 100 }));
      const opsNoBalance: Op[] = txs
        .filter((tx: any) => tx.category !== balanceCategoryId && tx.category !== interestCategoryId)
        .map((tx: any) => ({ date: tx.date, amount: tx.amount / 100 }));

      const balance = await actualClient.getAccountBalance(acc.id) / 100;
      const data: AccData = { ops, opsNoBalance, balance };
      cache.set(acc.id, data);
      return data;
    };

    // Prefetch all relevant accounts sequentially
    const allRelevant = [
      ...investmentAccounts,
      ...savingsEntries.map(e => e.account).filter((a, i, arr) => arr.findIndex(b => b.id === a.id) === i),
    ];
    console.error(`Fetching transactions for ${allRelevant.length} accounts…`);
    for (const acc of allRelevant) {
      await processAccount(acc);
    }

    // ── Build table ───────────────────────────────────────────────────────────
    const headers = [
      'Account', 'Investment', 'Yearly 15-day block IRR', 'XIRR',
      'Total gain', 'Livret A', 'Expected end of year',
    ];
    const fmts = ['s', '.2f', '.1%', '.1%', '.2f', '.2f', '.2f'];
    const rows: Row[] = [];

    // ── Section 1: investment accounts (PEE / PEA) ───────────────────────────
    for (const acc of investmentAccounts) {
      const { ops, opsNoBalance, balance } = await processAccount(acc);
      if (ops.length === 0) continue;

      const invested = opsNoBalance.reduce((s, op) => s + op.amount, 0);
      const currentGain = balance - invested;

      // Find the constant 15-day-block rate that reproduces the actual gain
      const bestRate = minimize1D(
        r => Math.abs(computeFinalBalance(r, ops, HM_NOW) - currentGain),
        -0.99, 5.0
      );

      const xirrVal = computeXirr(opsNoBalance, balance);
      const livretA = computeFinalBalance(RATES['Livret A'], ops, HM_NOW);
      const eoy = computeFinalBalance(bestRate, ops, END_OF_YEAR);

      rows.push([acc.name, invested, bestRate, xirrVal, currentGain, livretA, eoy]);
    }

    rows.push(ROW_SEP);

    // ── Section 2: regulated savings accounts ────────────────────────────────
    for (const { account: acc, rateHist } of savingsEntries) {
      const { ops, opsNoBalance, balance } = await processAccount(acc);

      // Sum of all operations BEFORE this year = opening balance proxy
      const previous = ops
        .filter(op => op.date < YEAR_START)
        .reduce((s, op) => s + op.amount, 0);

      // Skip accounts that had no capital before this year
      if (previous < 0.01) continue;

      // Current-year deposits/withdrawals, excluding balance-update transactions
      const yearOps = opsNoBalance.filter(
        op => op.date >= YEAR_START && op.date <= `${curYear}-12-31`
      );

      // Construct the simulation input: previous balance as a single entry at
      // the last day of the prior year, followed by this year's real flows
      const accOps: Op[] = [{ date: PREV_YEAR_END, amount: previous }, ...yearOps];

      const dueGains = computeFinalBalance(rateHist, accOps, HM_NOW);
      const livretA = computeFinalBalance(RATES['Livret A'], accOps, HM_NOW);
      const eoy = computeFinalBalance(rateHist, accOps, END_OF_YEAR);
      const currentRate = makeGetRate(rateHist)(HM_NOW - 1);
      const xirrVal = computeXirr(opsNoBalance, balance);

      rows.push([acc.name, balance, currentRate, xirrVal, dueGains, livretA, eoy]);
    }

    console.log(renderTable(headers, rows, fmts));
  }
}
