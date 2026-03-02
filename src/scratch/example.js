export default async function run(ctx) {
  const { q, runQuery } = ctx.api;

  const { data } = await runQuery(
    q('transactions')
      .filter({ date: { $gte: '2026-01-01' } })
      .select(['id', 'date', 'amount', 'payee.name'])
      .limit(10)
  );

  console.log('First 10 transactions in 2026:');
  for (const row of data) {
    console.log(`${row.date} | ${ctx.utils.integerToAmount(row.amount)} | ${row['payee.name'] || ''}`);
  }
}
