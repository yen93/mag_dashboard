import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useTheme } from '../hooks/useTheme.js';
import Segmented from '../components/Segmented.jsx';
import Sales from '../tabs/Sales.jsx';
import Marketing from '../tabs/Marketing.jsx';
import Operations from '../tabs/Operations.jsx';

const TABS = [
  { key: 'sales', label: 'Sales', Component: Sales },
  { key: 'marketing', label: 'Marketing', Component: Marketing },
  { key: 'operations', label: 'Operations', Component: Operations },
];

const RANGES = [
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
  { value: 'ytd', label: 'YTD' },
];

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const { theme, toggle } = useTheme();
  const [tab, setTab] = useState('sales');
  const [range, setRange] = useState('30d');

  const active = TABS.find((t) => t.key === tab) || TABS[0];
  const Active = active.Component;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          MAG Metrics
        </div>
        <div className="spacer" />
        <span className="user-chip">{user?.name || user?.email}</span>
        <button className="icon-btn" onClick={toggle} title="Toggle theme">
          {theme === 'dark' ? '☀ Light' : '☾ Dark'}
        </button>
        <button className="icon-btn" onClick={signOut}>
          Sign out
        </button>
      </header>

      <nav className="tabbar">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${t.key === tab ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="content">
        <div className="toolbar">
          <strong>{active.label} overview</strong>
          <div className="spacer" />
          <span className="muted" style={{ fontSize: 13 }}>
            Date range
          </span>
          <Segmented options={RANGES} value={range} onChange={setRange} ariaLabel="Date range" />
        </div>

        <Active range={range} />
      </main>
    </div>
  );
}
