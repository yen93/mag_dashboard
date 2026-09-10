import { useEffect, useState } from 'react';
import { fetchMetrics, AuthError } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';

// Fetches /api/metrics/<area>?range=<range>. On an auth failure it signs the
// user out, which sends them back to the login screen via ProtectedRoute.
export function useMetrics(area, range) {
  const { signOut } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    fetchMetrics(area, range)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof AuthError) {
          signOut();
        } else {
          setError(err.message || 'Failed to load metrics.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [area, range, signOut]);

  return { data, error, loading };
}
