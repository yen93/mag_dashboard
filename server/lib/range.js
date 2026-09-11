// Date-range helpers shared by the metric composers.
//
// The dashboard's range toggle is month-oriented (MAG's deals/events are best
// viewed monthly): 3M / 6M / 12M / YTD. Each maps to a start date and a list of
// month buckets (YYYY-MM) from start to the current month, so trends always have
// a complete, gap-free month axis.

export const RANGES = {
  '3m': { label: 'Last 3 months', months: 3 },
  '6m': { label: 'Last 6 months', months: 6 },
  '12m': { label: 'Last 12 months', months: 12 },
  ytd: { label: 'Year to date', months: null },
};

export function normalizeRange(range) {
  return RANGES[range] ? range : '12m';
}

/** Returns {startDate: 'YYYY-MM-01', months: [ 'YYYY-MM', ... ]} for a range. */
export function monthWindow(range, now = new Date()) {
  const key = normalizeRange(range);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based
  let start;
  if (key === 'ytd') {
    start = new Date(Date.UTC(y, 0, 1));
  } else {
    start = new Date(Date.UTC(y, m - (RANGES[key].months - 1), 1));
  }
  const months = [];
  const cursor = new Date(start);
  const end = new Date(Date.UTC(y, m, 1));
  while (cursor <= end) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return { startDate: start.toISOString().slice(0, 10), months };
}

/** Left-join DB rows (keyed by a 'YYYY-MM' field) onto the full month axis. */
export function fillMonths(months, rows, keyField, valueFields) {
  const byMonth = new Map(rows.map((r) => [r[keyField], r]));
  return months.map((mo) => {
    const row = byMonth.get(mo) || {};
    const out = { month: mo };
    for (const f of valueFields) out[f] = Number(row[f] || 0);
    return out;
  });
}

/** Percentage change, one decimal. */
export function pctChange(current, previous) {
  if (!previous) return 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}
