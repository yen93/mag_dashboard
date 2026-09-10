import { det, detInt, dateSeries, normalizeRange, sumBy, pctChange } from './util.js';

export function getMarketing(range) {
  const r = normalizeRange(range);
  const dates = dateSeries(r);

  const timeseries = dates.map((iso) => {
    const leads = detInt(`mkt:leads:${iso}`, 30, 160);
    const signups = Math.round(leads * det(`mkt:conv:${iso}`, 0.12, 0.34));
    const sessions = detInt(`mkt:sess:${iso}`, 800, 4200);
    return { date: iso, leads, signups, sessions };
  });

  const leadsTotal = sumBy(timeseries, 'leads');
  const signupsTotal = sumBy(timeseries, 'signups');
  const sessionsTotal = sumBy(timeseries, 'sessions');
  const convRate = leadsTotal ? Math.round((signupsTotal / leadsTotal) * 1000) / 10 : 0;

  const half = Math.floor(timeseries.length / 2);
  const recent = sumBy(timeseries.slice(half), 'leads');
  const prior = sumBy(timeseries.slice(0, half), 'leads');

  const openRate = Math.round(det(`mkt:open:${r}`, 28, 46) * 10) / 10;
  const clickRate = Math.round(det(`mkt:click:${r}`, 2.4, 7.8) * 10) / 10;

  const channels = [
    { source: 'Organic Search', value: detInt(`mkt:ch:org:${r}`, 25, 40) },
    { source: 'Paid Social', value: detInt(`mkt:ch:psoc:${r}`, 15, 28) },
    { source: 'Email', value: detInt(`mkt:ch:email:${r}`, 10, 22) },
    { source: 'Referral', value: detInt(`mkt:ch:ref:${r}`, 6, 15) },
    { source: 'Direct', value: detInt(`mkt:ch:dir:${r}`, 8, 18) },
  ];

  const campaigns = ['Summer Escapes', 'Weekend Warriors', 'Early Bird 2026', 'Adventure Club', 'Referral Boost'].map(
    (name) => ({
      name,
      sent: detInt(`mkt:cmp:sent:${name}:${r}`, 4000, 22000),
      openRate: Math.round(det(`mkt:cmp:open:${name}:${r}`, 24, 52) * 10) / 10,
      clickRate: Math.round(det(`mkt:cmp:click:${name}:${r}`, 1.8, 9.2) * 10) / 10,
      conversions: detInt(`mkt:cmp:conv:${name}:${r}`, 40, 620),
    })
  );

  const funnel = [
    { stage: 'Visitors', value: sessionsTotal },
    { stage: 'Leads', value: leadsTotal },
    { stage: 'Qualified', value: Math.round(leadsTotal * 0.55) },
    { stage: 'Signups', value: signupsTotal },
  ];

  return {
    range: r,
    kpis: {
      leads: { value: leadsTotal, unit: 'count', delta: pctChange(recent, prior) },
      signups: { value: signupsTotal, unit: 'count', delta: pctChange(signupsTotal, leadsTotal * 0.2) },
      convRate: { value: convRate, unit: 'percent', delta: pctChange(convRate, 20) },
      openRate: { value: openRate, unit: 'percent', delta: pctChange(openRate, 35) },
    },
    timeseries,
    channels,
    campaigns,
    funnel,
    email: { openRate, clickRate },
  };
}
