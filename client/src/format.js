const currency = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  maximumFractionDigits: 0,
});
const number = new Intl.NumberFormat('en-AU');

export function formatValue(value, unit) {
  switch (unit) {
    case 'currency':
      return currency.format(value);
    case 'percent':
      return `${value}%`;
    case 'hours':
      return `${value}h`;
    default:
      return number.format(value);
  }
}

export function formatDelta(delta) {
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta}%`;
}

export function shortDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
}
