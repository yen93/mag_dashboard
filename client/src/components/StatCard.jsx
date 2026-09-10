import { formatValue, formatDelta } from '../format.js';

// A KPI tile. `invertDelta` flips the good/bad coloring for metrics where lower
// is better (e.g. turnaround time).
export default function StatCard({ label, value, unit, delta = 0, invertDelta = false }) {
  const good = invertDelta ? delta < 0 : delta > 0;
  const deltaClass = delta === 0 ? '' : good ? 'pos' : 'neg';
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{formatValue(value, unit)}</div>
      {delta !== 0 && (
        <div className={`delta ${deltaClass}`}>
          {formatDelta(delta)} vs. prior
        </div>
      )}
    </div>
  );
}
