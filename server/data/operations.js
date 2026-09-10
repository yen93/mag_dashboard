import { det, detInt, dateSeries, normalizeRange, sumBy, pctChange } from './util.js';

function seasonFactor(iso) {
  const day = new Date(iso).getDay();
  if (day === 0 || day === 6) return 1.4;
  if (day === 5) return 1.2;
  return 1;
}

export function getOperations(range) {
  const r = normalizeRange(range);
  const dates = dateSeries(r);

  const timeseries = dates.map((iso) => {
    const bookings = Math.round(detInt(`ops:book:${iso}`, 20, 90) * seasonFactor(iso));
    const capacity = detInt(`ops:cap:${iso}`, 90, 130);
    const utilization = Math.min(100, Math.round((bookings / capacity) * 100));
    const turnaround = Math.round(det(`ops:turn:${iso}`, 1.2, 4.6) * 10) / 10; // hours
    const onTime = Math.round(det(`ops:ontime:${iso}`, 88, 99));
    return { date: iso, bookings, utilization, turnaround, onTime };
  });

  const bookingsTotal = sumBy(timeseries, 'bookings');
  const avgUtilization = Math.round(sumBy(timeseries, 'utilization') / timeseries.length);
  const avgTurnaround = Math.round((sumBy(timeseries, 'turnaround') / timeseries.length) * 10) / 10;
  const avgOnTime = Math.round(sumBy(timeseries, 'onTime') / timeseries.length);

  const half = Math.floor(timeseries.length / 2);
  const recent = sumBy(timeseries.slice(half), 'bookings');
  const prior = sumBy(timeseries.slice(0, half), 'bookings');

  const issues = [
    { category: 'Equipment', open: detInt(`ops:iss:eq:${r}`, 2, 14), priority: 'High' },
    { category: 'Scheduling', open: detInt(`ops:iss:sch:${r}`, 3, 18), priority: 'Medium' },
    { category: 'Staffing', open: detInt(`ops:iss:staff:${r}`, 1, 9), priority: 'High' },
    { category: 'Customer', open: detInt(`ops:iss:cust:${r}`, 4, 20), priority: 'Low' },
    { category: 'Facilities', open: detInt(`ops:iss:fac:${r}`, 0, 7), priority: 'Medium' },
  ];
  const openIssues = sumBy(issues, 'open');

  const locations = ['Blue Mountains', 'Gold Coast', 'Byron Bay', 'Cairns'].map((name) => ({
    name,
    utilization: detInt(`ops:loc:${name}:${r}`, 62, 96),
    bookings: detInt(`ops:locb:${name}:${r}`, 120, 620),
  }));

  return {
    range: r,
    kpis: {
      bookings: { value: bookingsTotal, unit: 'count', delta: pctChange(recent, prior) },
      utilization: { value: avgUtilization, unit: 'percent', delta: pctChange(avgUtilization, 70) },
      turnaround: { value: avgTurnaround, unit: 'hours', delta: pctChange(avgTurnaround, 3) },
      onTime: { value: avgOnTime, unit: 'percent', delta: pctChange(avgOnTime, 92) },
    },
    timeseries,
    issues,
    openIssues,
    locations,
  };
}
