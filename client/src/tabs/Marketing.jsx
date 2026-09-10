import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
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
const PIE_COLORS = ['#3b6ef0', '#7c5cff', '#17a673', '#f0a63b', '#e2483d'];

export default function Marketing({ range }) {
  const { data, error, loading } = useMetrics('marketing', range);

  if (loading) return <div className="loading">Loading marketing metrics…</div>;
  if (error) return <div className="error">{error}</div>;
  if (!data) return null;

  const { kpis, timeseries, channels, campaigns, funnel } = data;

  return (
    <>
      <div className="kpi-grid">
        <StatCard label="Leads" {...kpis.leads} />
        <StatCard label="Signups" {...kpis.signups} />
        <StatCard label="Conversion rate" {...kpis.convRate} />
        <StatCard label="Email open rate" {...kpis.openRate} />
      </div>

      <div className="grid" style={{ marginBottom: 16 }}>
        <TrendChart
          title="Acquisition over time"
          data={timeseries}
          series={[
            { key: 'leads', label: 'Leads', color: '#3b6ef0', unit: 'count' },
            { key: 'signups', label: 'Signups', color: '#17a673', unit: 'count' },
            { key: 'sessions', label: 'Sessions', color: '#f0a63b', unit: 'count' },
          ]}
        />
      </div>

      <div className="grid">
        <div className="card col-6">
          <div className="card-head">
            <h3>Traffic sources</h3>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie
                data={channels}
                dataKey="value"
                nameKey="source"
                innerRadius={55}
                outerRadius={95}
                paddingAngle={2}
              >
                {channels.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${v}%`} />
            </PieChart>
          </ResponsiveContainer>
          <div className="chips" style={{ justifyContent: 'center' }}>
            {channels.map((c, i) => (
              <span key={c.source} className="chip on">
                <span className="swatch" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                {c.source} · {c.value}%
              </span>
            ))}
          </div>
        </div>

        <div className="card col-6">
          <div className="card-head">
            <h3>Conversion funnel</h3>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart
              data={funnel}
              layout="vertical"
              margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" horizontal={false} />
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="stage"
                width={80}
                stroke="var(--text-muted)"
                fontSize={12}
              />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => formatValue(v, 'count')} />
              <Bar dataKey="value" fill="var(--accent)" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card col-12">
          <div className="card-head">
            <h3>Campaign performance</h3>
          </div>
          <table className="data">
            <thead>
              <tr>
                <th>Campaign</th>
                <th className="num">Sent</th>
                <th className="num">Open rate</th>
                <th className="num">Click rate</th>
                <th className="num">Conversions</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className="num">{formatValue(c.sent, 'count')}</td>
                  <td className="num">{c.openRate}%</td>
                  <td className="num">{c.clickRate}%</td>
                  <td className="num">{formatValue(c.conversions, 'count')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
