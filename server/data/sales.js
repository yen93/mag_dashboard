import { det, detInt, dateSeries, normalizeRange, sumBy, pctChange } from './util.js';

// Weekend seasonality factor (adventure business: busier on weekends).
function seasonFactor(iso) {
  const day = new Date(iso).getDay(); // 0 Sun ... 6 Sat
  if (day === 0 || day === 6) return 1.35;
  if (day === 5) return 1.15;
  return 1;
}

export function getSales(range) {
  const r = normalizeRange(range);
  const dates = dateSeries(r);

  const timeseries = dates.map((iso) => {
    const base = det(`sales:rev:${iso}`, 4200, 12800) * seasonFactor(iso);
    const revenue = Math.round(base);
    const deals = detInt(`sales:deals:${iso}`, 4, 22);
    const won = Math.min(deals, detInt(`sales:won:${iso}`, 2, deals));
    const lost = deals - won;
    return { date: iso, revenue, deals, won, lost };
  });

  const revenueTotal = sumBy(timeseries, 'revenue');
  const wonTotal = sumBy(timeseries, 'won');
  const lostTotal = sumBy(timeseries, 'lost');
  const winRate = wonTotal + lostTotal ? Math.round((wonTotal / (wonTotal + lostTotal)) * 100) : 0;
  const avgDealSize = wonTotal ? Math.round(revenueTotal / wonTotal) : 0;

  // Prior period comparison (same length, immediately before) for KPI deltas.
  const half = Math.floor(timeseries.length / 2);
  const recent = sumBy(timeseries.slice(half), 'revenue');
  const prior = sumBy(timeseries.slice(0, half), 'revenue');

  const pipeline = [
    { stage: 'Enquiry', value: detInt(`sales:pipe:enq:${r}`, 120000, 180000), count: detInt(`sales:pipec:enq:${r}`, 60, 110) },
    { stage: 'Qualified', value: detInt(`sales:pipe:qual:${r}`, 80000, 140000), count: detInt(`sales:pipec:qual:${r}`, 35, 70) },
    { stage: 'Proposal', value: detInt(`sales:pipe:prop:${r}`, 50000, 95000), count: detInt(`sales:pipec:prop:${r}`, 18, 40) },
    { stage: 'Negotiation', value: detInt(`sales:pipe:neg:${r}`, 25000, 60000), count: detInt(`sales:pipec:neg:${r}`, 8, 22) },
    { stage: 'Closing', value: detInt(`sales:pipe:close:${r}`, 12000, 35000), count: detInt(`sales:pipec:close:${r}`, 4, 12) },
  ];

  const repNames = ['Ava Chen', 'Liam Brooks', 'Noah Patel', 'Mia Rossi', 'Ethan Ward'];
  const topReps = repNames
    .map((name) => ({
      name,
      revenue: detInt(`sales:rep:${name}:${r}`, 45000, 210000),
      deals: detInt(`sales:repd:${name}:${r}`, 8, 44),
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    range: r,
    kpis: {
      revenue: { value: revenueTotal, unit: 'currency', delta: pctChange(recent, prior) },
      dealsWon: { value: wonTotal, unit: 'count', delta: pctChange(wonTotal, lostTotal) },
      winRate: { value: winRate, unit: 'percent', delta: pctChange(winRate, 50) },
      avgDealSize: { value: avgDealSize, unit: 'currency', delta: pctChange(avgDealSize, avgDealSize * 0.95) },
    },
    timeseries,
    pipeline,
    topReps,
  };
}
