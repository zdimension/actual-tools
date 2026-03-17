import { ScratchContext } from "../scratch-context.js";

export default async function run(ctx: ScratchContext) {
  const { q, aqlQuery } = ctx.api;

  /*const { data } = (await aqlQuery(
    q('transactions')
      .filter({ date: { $gte: '2026-01-01' } })
      .select(['id', 'date', 'amount', 'payee.name'])
      .limit(10)
  )) as any;

  console.log('First 10 transactions in 2026:');
  for (const row of data) {
    console.log(`${row.date} | ${ctx.utils.integerToAmount(row.amount)} | ${row['payee.name'] || ''}`);
  }*/
const accs = await ctx.api.getAccounts();
  const balance = new Map<string, number>();
  for (const acc of accs) {
    const owner = acc.name.split(/\s+/)[0];
    const bal = await ctx.api.getAccountBalance(acc.id);
    balance.set(owner, (balance.get(owner) ?? 0) + bal);
  }
  console.log('Total balance by owner:');
  for (const [owner, bal] of balance) {
    console.log(`${owner}: ${ctx.utils.integerToAmount(bal)}`);
  }
  /*const accs = await ctx.api.getAccounts();
  const balance = new Map<string, number>();
  for (const acc of accs) {
    const owner = acc.name.split(/\s+/)[0];
    const bal = await ctx.api.getAccountBalance(acc.id);
    balance.set(owner, (balance.get(owner) ?? 0) + bal);
  }
  console.log('Total balance by owner:');
  for (const [owner, bal] of balance) {
    console.log(`${owner}: ${ctx.utils.integerToAmount(bal)}`);
  }
  const qu = q('transactions')
    .filter({ 'account.name': { $regexp: '^Tom' } })
    .filter({ category: { $ne: null } })
    .filter({ amount: { $lt: 0 } })
    .calculate({ $sum: '$amount' });
  console.log(qu.raw());
  console.log(qu.serializeAsString());
  const { data } = await aqlQuery(
    qu
  ) as any;
  console.log('Total positive amount for accounts starting with "Tom":', ctx.utils.integerToAmount(data));
*/

  const accsTom = (await ctx.api.getAccounts()).filter(acc => acc.name.startsWith('Tom'));
  console.log(`Found ${accsTom.length} accounts starting with "Tom"`);
  const transTom = [];
  for (const acc of accsTom) {
    /*const txs = await ctx.api.getTransactions(acc.id, '', '');
    transTom.push(...txs);*/
    const { data: txs } = (await aqlQuery(
      q('transactions')
        .filter({ 'account.id': acc.id })
        .select(['transfer_id', 'amount'])
    )) as any;
    //console.log(`Account "${acc.name}" has ${txs.length} transactions`);
    transTom.push(...txs);
  }
  console.log(JSON.stringify(transTom[0], null, 2));

  console.log(transTom.filter(t => !t.transfer_id).reduce((sum, t) => sum + t.amount, 0));
  console.log(transTom.filter(t => !t.transfer_id && t.amount < 0).reduce((sum, t) => sum + t.amount, 0));
  console.log(transTom.filter(t => !t.transfer_id && t.amount > 0).reduce((sum, t) => sum + t.amount, 0));
  console.log(transTom.reduce((sum, t) => sum + t.amount, 0));


  /* const ops = await ctx.api.getTransactions();
   const balOps = new Map<string, number>();
*/
}
