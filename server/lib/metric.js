// Helpers to wrap values in a consistent metric shape the frontend understands.
// Every metric/section carries `meta` describing its source and whether it's
// live or still "pending" (needs a credential or data-hygiene step). The pages
// render a source chip and a "needs setup" badge from this meta.

export function live(value, unit, { source, delta = null, note = null } = {}) {
  return { value, unit, delta, meta: { status: 'live', source, note } };
}

export function pending(unit, { source = null, note } = {}) {
  return { value: null, unit, delta: null, meta: { status: 'pending', source, note } };
}

// A chart/table section wrapper with its own meta.
export function section(data, { source, status = 'live', note = null } = {}) {
  return { data, meta: { status, source, note } };
}
