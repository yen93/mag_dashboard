import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { useMetrics } from '../hooks/useMetrics.js';
import StatCard from '../components/StatCard.jsx';
import TrendChart from '../components/TrendChart.jsx';
import { formatValue } from '../format.js';

const tooltipStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  color: 'var(--text)',
};

export default function Sales({ range }) {
  const { data, error, loading } = useMetrics('sales', range);

  if (loading) return <div className="loading">Loading sales metrics…</div>;
  if (error) return <div className="error">{error}</div>;
  if (!data) return null;

  const { kpis, timeseries, pipeline, topReps } = data;

  return (
    <>
      <div className="kpi-grid">
        <StatCard label="Revenue" {...kpis.revenue} />
        <StatCard label="Deals won" {...kpis.dealsWon} />
        <StatCard label="Win rate" {...kpis.winRate} />
        <StatCard label="Avg deal size" {...kpis.avgDealSize} />
      </div>

      <div className="grid" style={{ marginBottom: 16 }}>
        <TrendChart
          title="Deals over time"
          data={timeseries}
          series={[
            { key: 'won', label: 'Won', color: '#17a673', unit: 'count' },
            { key: 'lost', label: 'Lost', color: '#e2483d', unit: 'count' },
            { key: 'deals', label: 'Total', color: '#3b6ef0', unit: 'count' },
          ]}
        />
      </div>

      <div className="grid">
        <div className="card col-8">
          <div className="card-head">
            <h3>Revenue by day</h3>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={timeseries} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="date" hide />
              <YAxis stroke="var(--text-muted)" fontSize={12} width={54} />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v) => formatValue(v, 'currency')}
              />
              <Bar dataKey="revenue" fill="var(--accent)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card col-4">
          <div className="card-head">
            <h3>Pipeline by stage</h3>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart
              data={pipeline}
              layout="vertical"
              margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" horizontal={false} />
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="stage"
                width={92}
                stroke="var(--text-muted)"
                fontSize={12}
              />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => formatValue(v, 'currency')} />
              <Bar dataKey="value" fill="#7c5cff" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card col-12">
          <div className="card-head">
            <h3>Top sales reps</h3>
          </div>
          <table className="data">
            <thead>
              <tr>
                <th>Rep</th>
                <th className="num">Deals</th>
                <th className="num">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {topReps.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td className="num">{r.deals}</td>
                  <td className="num">{formatValue(r.revenue, 'currency')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
