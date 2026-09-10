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

const PRIORITY_COLOR = { High: '#e2483d', Medium: '#f0a63b', Low: '#17a673' };

export default function Operations({ range }) {
  const { data, error, loading } = useMetrics('operations', range);

  if (loading) return <div className="loading">Loading operations metrics…</div>;
  if (error) return <div className="error">{error}</div>;
  if (!data) return null;

  const { kpis, timeseries, issues, locations } = data;

  return (
    <>
      <div className="kpi-grid">
        <StatCard label="Bookings" {...kpis.bookings} />
        <StatCard label="Capacity utilization" {...kpis.utilization} />
        <StatCard label="Avg turnaround" {...kpis.turnaround} invertDelta />
        <StatCard label="On-time rate" {...kpis.onTime} />
      </div>

      <div className="grid" style={{ marginBottom: 16 }}>
        <TrendChart
          title="Operations over time"
          data={timeseries}
          series={[
            { key: 'bookings', label: 'Bookings', color: '#3b6ef0', unit: 'count' },
            { key: 'utilization', label: 'Utilization %', color: '#7c5cff', unit: 'percent' },
            { key: 'onTime', label: 'On-time %', color: '#17a673', unit: 'percent' },
          ]}
        />
      </div>

      <div className="grid">
        <div className="card col-6">
          <div className="card-head">
            <h3>Utilization by location</h3>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={locations} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={12} />
              <YAxis stroke="var(--text-muted)" fontSize={12} width={40} unit="%" />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${v}%`} />
              <Bar dataKey="utilization" fill="var(--accent)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card col-6">
          <div className="card-head">
            <h3>Open issues by category</h3>
          </div>
          <table className="data">
            <thead>
              <tr>
                <th>Category</th>
                <th>Priority</th>
                <th className="num">Open</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((i) => (
                <tr key={i.category}>
                  <td>{i.category}</td>
                  <td>
                    <span
                      className="chip on"
                      style={{ borderColor: PRIORITY_COLOR[i.priority] }}
                    >
                      <span className="swatch" style={{ background: PRIORITY_COLOR[i.priority] }} />
                      {i.priority}
                    </span>
                  </td>
                  <td className="num">{i.open}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card col-12">
          <div className="card-head">
            <h3>Bookings by location</h3>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={locations} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={12} />
              <YAxis stroke="var(--text-muted)" fontSize={12} width={48} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => formatValue(v, 'count')} />
              <Bar dataKey="bookings" fill="#7c5cff" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}
