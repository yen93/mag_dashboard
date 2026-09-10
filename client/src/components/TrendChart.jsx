import { useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import SeriesToggle from './SeriesToggle.jsx';
import Segmented from './Segmented.jsx';
import { shortDate, formatValue } from '../format.js';

// A time-series card with two interactive toggles:
//  - series chips (show/hide each line)
//  - chart / table view switch
export default function TrendChart({ title, data, series }) {
  const [visible, setVisible] = useState(
    Object.fromEntries(series.map((s) => [s.key, true]))
  );
  const [view, setView] = useState('chart');

  const toggle = (key) =>
    setVisible((v) => ({ ...v, [key]: !v[key] }));

  const shownSeries = series.filter((s) => visible[s.key]);

  return (
    <div className="card col-12">
      <div className="card-head">
        <h3>{title}</h3>
        <div className="spacer" />
        <SeriesToggle series={series} visible={visible} onToggle={toggle} />
        <Segmented
          ariaLabel="View mode"
          options={[
            { value: 'chart', label: 'Chart' },
            { value: 'table', label: 'Table' },
          ]}
          value={view}
          onChange={setView}
        />
      </div>

      {view === 'chart' ? (
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" />
            <XAxis
              dataKey="date"
              tickFormatter={shortDate}
              stroke="var(--text-muted)"
              fontSize={12}
              minTickGap={24}
            />
            <YAxis stroke="var(--text-muted)" fontSize={12} width={48} />
            <Tooltip
              contentStyle={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                color: 'var(--text)',
              }}
              labelFormatter={shortDate}
            />
            {shownSeries.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>Date</th>
                {shownSeries.map((s) => (
                  <th key={s.key} className="num">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.date}>
                  <td>{shortDate(row.date)}</td>
                  {shownSeries.map((s) => (
                    <td key={s.key} className="num">
                      {formatValue(row[s.key], s.unit)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
