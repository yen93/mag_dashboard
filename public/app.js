/* ============================================================================
   MAG Metrics Dashboard — shared front-end logic (plain JS, no build step).
   Loaded by every dashboard page. Handles login/auth, data fetching,
   formatting, the shared top bar / tabs / date-range toggle, theme, and
   Chart.js helpers. Page-specific rendering lives in each *.html file.
   ============================================================================ */

/* ---------- Auth / token ---------- */
var TOKEN_KEY = 'mag_token';
function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }

function currentUser() {
  var t = getToken();
  if (!t) return null;
  try {
    var p = JSON.parse(atob(t.split('.')[1]));
    if (p.exp && p.exp * 1000 < Date.now()) return null; // expired
    return { id: p.sub, email: p.email, name: p.name, role: p.role };
  } catch (e) { return null; }
}

function logout() { setToken(null); window.location.href = 'login.html'; }

/** Redirect to login if not signed in. Call at the top of each protected page. */
function requireLogin() {
  if (!currentUser()) { window.location.href = 'login.html'; return false; }
  return true;
}

/* ---------- API ---------- */
function apiLogin(email, password) {
  return fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: password }),
  }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) throw new Error(data.error || 'Login failed');
      return data;
    });
  });
}

// GET any authenticated JSON endpoint (adds the Bearer token, logs out on 401).
function fetchJSON(path) {
  return fetch(path, {
    headers: { Authorization: 'Bearer ' + getToken() },
  }).then(function (res) {
    if (res.status === 401) { logout(); throw new Error('Session expired'); }
    return res.json().then(function (data) {
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    });
  });
}

function fetchMetrics(area, range) {
  return fetchJSON('/api/metrics/' + area + '?range=' + encodeURIComponent(range));
}

/* ---------- Formatting ---------- */
var _aud = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
var _num = new Intl.NumberFormat('en-AU');
function fmt(value, unit) {
  if (value === null || value === undefined) return '—';
  if (unit === 'currency') return _aud.format(value);
  if (unit === 'percent') return value + '%';
  if (unit === 'hours') return value + 'h';
  if (unit === 'rating') return value + '★';
  return _num.format(value);
}
function fmtDelta(d) { return (d > 0 ? '+' : '') + d + '%'; }
function shortDate(iso) {
  var d = new Date(iso);
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
}
// Month label from a 'YYYY-MM' bucket.
function monthLabel(ym) {
  if (!ym) return '';
  var p = ym.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, 1)).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' });
}
// Week label from a 'YYYY-MM-DD' (ISO week start).
function weekLabel(iso) { return shortDate(iso); }
// Full date "12 Feb 2026" (empty string for null/invalid).
function fmtDate(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

/* ---------- Theme ---------- */
var THEME_KEY = 'mag_theme';
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
}
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}
function toggleTheme() {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  if (typeof window.onThemeChange === 'function') window.onThemeChange();
}
// Read the resolved theme colors (from CSS variables) for charts.
function themeColors() {
  var s = getComputedStyle(document.documentElement);
  var g = function (n) { return s.getPropertyValue(n).trim(); };
  return {
    text: g('--text'), muted: g('--text-muted'), grid: g('--grid'),
    surface: g('--surface'), border: g('--border'), accent: g('--accent'),
  };
}
// Categorical palette for charts (edit to rebrand).
var PALETTE = ['#3b6ef0', '#7c5cff', '#17a673', '#f0a63b', '#e2483d'];

/* ---------- Shared date range (persists across pages) ---------- */
var RANGE_KEY = 'mag_range';
function getRange() { try { return localStorage.getItem(RANGE_KEY) || '12m'; } catch (e) { return '12m'; } }
function setRange(r) { try { localStorage.setItem(RANGE_KEY, r); } catch (e) {} }

/* ---------- meta chips (source + "needs setup") ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
  return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

// Small chips describing a metric/section's provenance and readiness.
function metaChips(meta) {
  if (!meta) return '';
  var out = '';
  if (meta.source) out += '<span class="chip src">' + esc(meta.source) + '</span>';
  if (meta.status === 'pending') out += '<span class="chip warn" title="' + esc(meta.note) + '">needs setup</span>';
  else if (meta.status === 'partial') out += '<span class="chip partial" title="' + esc(meta.note) + '">partial</span>';
  return out;
}

// Render "needs setup" placeholder body into a card element (returns true if it did).
function renderPendingBody(elId, meta) {
  var el = document.getElementById(elId);
  if (!el) return false;
  el.innerHTML = '<div class="needs-setup"><strong>Needs setup</strong><span>' +
    esc(meta && meta.note ? meta.note : 'This metric isn’t connected yet.') + '</span></div>';
  return true;
}

/* ---------- KPI + table rendering helpers ---------- */
// cards: [{ label, metric:{value,unit,delta,meta}, invert? }]
function renderKpis(containerId, cards) {
  var html = cards.map(function (c) {
    var m = c.metric || {};
    var pending = m.meta && m.meta.status === 'pending';
    var deltaClass = m.delta === 0 || m.delta == null ? '' : (c.invert ? m.delta < 0 : m.delta > 0) ? 'pos' : 'neg';
    var deltaHtml = (pending || m.delta === 0 || m.delta == null) ? '' :
      '<div class="delta ' + deltaClass + '">' + fmtDelta(m.delta) + ' vs. prior</div>';
    var note = (m.meta && m.meta.note) ? ' title="' + esc(m.meta.note) + '"' : '';
    return '<div class="kpi"' + note + '><div class="label">' + esc(c.label) + '</div>' +
      '<div class="value">' + (pending ? '—' : fmt(m.value, m.unit)) + '</div>' +
      deltaHtml + '<div class="chips" style="margin-top:8px">' + metaChips(m.meta) + '</div></div>';
  }).join('');
  document.getElementById(containerId).innerHTML = html;
}

/* Build a simple HTML table. columns: [{key,label,unit,pill}] */
function renderTable(containerId, rows, columns) {
  var thead = '<tr>' + columns.map(function (c) {
    return '<th class="' + (c.unit && c.unit !== 'text' ? 'num' : '') + '">' + c.label + '</th>';
  }).join('') + '</tr>';
  var tbody = rows.map(function (row) {
    return '<tr>' + columns.map(function (c) {
      var v = row[c.key];
      if (c.render) return '<td class="' + (c.unit && c.unit !== 'text' ? 'num' : '') + '">' + c.render(v, row) + '</td>';
      var cls = (c.unit && c.unit !== 'text') ? 'num' : '';
      return '<td class="' + cls + '">' + (c.unit ? fmt(v, c.unit) : v) + '</td>';
    }).join('') + '</tr>';
  }).join('');
  document.getElementById(containerId).innerHTML =
    '<table class="data"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table>';
}

/* Sortable + searchable table. Builds its own search box and re-renders on
   header click / typing. columns: [{key,label,unit,render}] (same shape as
   renderTable; `unit:'date'` sorts chronologically). opts:
   { search, searchPlaceholder, emptyText, sortKey, sortDir, onCount }.
   Cell text is escaped unless a column supplies its own `render` (which is
   responsible for escaping its output). */
function renderSortableTable(containerId, rows, columns, opts) {
  opts = opts || {};
  var host = document.getElementById(containerId);
  if (!host) return;
  // state.filters maps a column key -> Set of allowed plain-text values
  // (textOf projection). A column absent from the map is unfiltered.
  var state = { key: opts.sortKey || null, dir: opts.sortDir || 'asc', q: '', filters: {} };
  var filterable = opts.columnFilters !== false;
  var openPanel = null; // currently-open column-filter panel (mounted on <body>)

  function isNum(c) { return c && c.unit && c.unit !== 'text' && c.unit !== 'date'; }
  // Plain-text projection of a cell, used for search + text sorting.
  function textOf(row, c) {
    var v = row[c.key];
    if (c.render) return String(c.render(v, row) == null ? '' : c.render(v, row)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (v == null) return '';
    if (isNum(c)) return String(fmt(v, c.unit));
    if (c.unit === 'date') return fmtDate(v);
    return String(v);
  }

  function view() {
    var list = rows.slice();
    if (state.q) {
      var q = state.q.toLowerCase();
      list = list.filter(function (row) {
        return columns.some(function (c) { return textOf(row, c).toLowerCase().indexOf(q) !== -1; });
      });
    }
    var fkeys = Object.keys(state.filters);
    if (fkeys.length) {
      list = list.filter(function (row) {
        return fkeys.every(function (k) {
          var set = state.filters[k];
          var col = columns.filter(function (c) { return c.key === k; })[0];
          return !col || set.has(textOf(row, col));
        });
      });
    }
    if (state.key) {
      var col = columns.filter(function (c) { return c.key === state.key; })[0];
      list.sort(function (a, b) {
        var av, bv;
        if (isNum(col)) { av = Number(a[col.key]); bv = Number(b[col.key]); if (isNaN(av)) av = -Infinity; if (isNaN(bv)) bv = -Infinity; }
        else if (col.unit === 'date') { av = new Date(a[col.key] || 0).getTime() || 0; bv = new Date(b[col.key] || 0).getTime() || 0; }
        else { av = textOf(a, col).toLowerCase(); bv = textOf(b, col).toLowerCase(); }
        if (av < bv) return state.dir === 'asc' ? -1 : 1;
        if (av > bv) return state.dir === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return list;
  }

  function draw() {
    var list = view();
    var thead = '<tr>' + columns.map(function (c) {
      var active = state.key === c.key;
      var caret = active ? (state.dir === 'asc' ? ' ▲' : ' ▼') : '';
      var funnel = filterable
        ? '<button type="button" class="th-filter-btn' + (state.filters[c.key] ? ' active' : '') +
          '" data-fkey="' + esc(c.key) + '" aria-label="Filter ' + esc(c.label) + '" title="Filter">▾</button>'
        : '';
      return '<th class="sortable ' + (isNum(c) ? 'num ' : '') + (active ? 'active' : '') +
        '" data-key="' + esc(c.key) + '"><span class="th-label">' + esc(c.label) + caret + '</span>' + funnel + '</th>';
    }).join('') + '</tr>';
    var tbody = list.length ? list.map(function (row) {
      return '<tr>' + columns.map(function (c) {
        var v = row[c.key];
        var cell = c.render ? c.render(v, row) : (v == null ? '—' : (isNum(c) ? fmt(v, c.unit) : (c.unit === 'date' ? esc(fmtDate(v)) : esc(v))));
        return '<td class="' + (isNum(c) ? 'num' : '') + '">' + cell + '</td>';
      }).join('') + '</tr>';
    }).join('') : '<tr><td class="muted" colspan="' + columns.length + '">' + esc(opts.emptyText || 'No rows.') + '</td></tr>';

    box.innerHTML = '<table class="data sortable-table"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table>';
    box.querySelectorAll('th.sortable').forEach(function (th) {
      th.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('.th-filter-btn')) return; // filter button handles itself
        var k = th.getAttribute('data-key');
        if (state.key === k) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else { state.key = k; state.dir = 'asc'; }
        draw();
      });
    });
    if (filterable) {
      box.querySelectorAll('.th-filter-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var k = btn.getAttribute('data-fkey');
          var col = columns.filter(function (c) { return c.key === k; })[0];
          if (col) toggleFilter(btn.closest('th'), col);
        });
      });
    }
    if (typeof opts.onCount === 'function') opts.onCount(list.length, rows.length);
  }

  // ---- per-column value filters (Google-Sheets style) ----
  function distinctValues(col) {
    var seen = {}, out = [];
    rows.forEach(function (row) {
      var t = textOf(row, col);
      if (!Object.prototype.hasOwnProperty.call(seen, t)) { seen[t] = true; out.push(t); }
    });
    out.sort(function (a, b) {
      if (a === b) return 0;
      if (a === '') return 1;   // blanks last
      if (b === '') return -1;
      var la = a.toLowerCase(), lb = b.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
    return out;
  }

  function closePanel() {
    if (!openPanel) return;
    openPanel.remove();
    openPanel = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', closePanel, true);
    window.removeEventListener('resize', closePanel, true);
  }
  function onDocDown(e) {
    if (!openPanel) return;
    if (!openPanel.contains(e.target) && !(e.target.closest && e.target.closest('.th-filter-btn'))) closePanel();
  }
  function onKeyDown(e) { if (e.key === 'Escape') closePanel(); }

  function toggleFilter(th, col) {
    var wasThis = openPanel && openPanel.getAttribute('data-key') === col.key;
    closePanel();
    if (wasThis) return;
    openFilterPanel(th, col);
  }

  function openFilterPanel(th, col) {
    var values = distinctValues(col);
    var allowed = state.filters[col.key]; // Set or undefined (= all)

    var panel = document.createElement('div');
    panel.className = 'col-filter-panel';
    panel.setAttribute('data-key', col.key);

    var search = document.createElement('input');
    search.type = 'search'; search.className = 'cf-search'; search.placeholder = 'Filter values…';

    var actions = document.createElement('div'); actions.className = 'cf-actions';
    var selAll = document.createElement('button'); selAll.type = 'button'; selAll.className = 'cf-link'; selAll.textContent = 'Select all';
    var clr = document.createElement('button'); clr.type = 'button'; clr.className = 'cf-link'; clr.textContent = 'Clear';
    actions.appendChild(selAll); actions.appendChild(clr);

    var listEl = document.createElement('div'); listEl.className = 'cf-list';

    function isChecked(v) { return !allowed || allowed.has(v); }
    function ensureSet() { if (!allowed) allowed = new Set(values); return allowed; }
    function apply() {
      if (allowed && allowed.size === values.length) { delete state.filters[col.key]; allowed = undefined; }
      else if (allowed) { state.filters[col.key] = allowed; }
      draw();
    }
    function renderList() {
      var q = search.value.trim().toLowerCase();
      listEl.innerHTML = '';
      values.forEach(function (v) {
        var label = v === '' ? '(Blanks)' : v;
        if (q && label.toLowerCase().indexOf(q) === -1) return;
        var item = document.createElement('label'); item.className = 'cf-item';
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = isChecked(v);
        cb.addEventListener('change', function () {
          var set = ensureSet();
          if (cb.checked) set.add(v); else set.delete(v);
          apply();
        });
        var span = document.createElement('span'); span.textContent = label;
        item.appendChild(cb); item.appendChild(span);
        listEl.appendChild(item);
      });
    }
    search.addEventListener('input', renderList);
    selAll.addEventListener('click', function () { allowed = new Set(values); apply(); renderList(); });
    clr.addEventListener('click', function () { allowed = new Set(); apply(); renderList(); });

    panel.appendChild(search); panel.appendChild(actions); panel.appendChild(listEl);
    document.body.appendChild(panel);
    renderList();

    var r = th.getBoundingClientRect();
    panel.style.top = (r.bottom + window.scrollY + 2) + 'px';
    var left = r.left + window.scrollX;
    var maxLeft = window.scrollX + document.documentElement.clientWidth - panel.offsetWidth - 8;
    if (left > maxLeft) left = Math.max(window.scrollX + 8, maxLeft);
    panel.style.left = left + 'px';

    openPanel = panel;
    setTimeout(function () {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('scroll', closePanel, true);
      window.addEventListener('resize', closePanel, true);
    }, 0);
    search.focus();
  }

  host.innerHTML = '';
  if (opts.search !== false) {
    var input = document.createElement('input');
    input.type = 'search';
    input.className = 'table-search';
    input.placeholder = opts.searchPlaceholder || 'Search…';
    input.addEventListener('input', function () { state.q = input.value.trim(); draw(); });
    host.appendChild(input);
  }
  var box = document.createElement('div');
  box.className = 'table-scroll';
  host.appendChild(box);
  draw();
}

/* ---------- Chart.js helpers ---------- */
var _charts = {}; // canvasId -> Chart instance (so we can destroy/recreate)

function _baseOptions(tc) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: tc.text, usePointStyle: true, boxWidth: 8 } },
      tooltip: { backgroundColor: tc.surface, titleColor: tc.text, bodyColor: tc.text, borderColor: tc.border, borderWidth: 1 },
    },
    scales: {
      x: { ticks: { color: tc.muted }, grid: { color: tc.grid } },
      y: { ticks: { color: tc.muted }, grid: { color: tc.grid } },
    },
  };
}

/* Line chart. series: [{key,label,color}]. Legend click hides a line.
   opts: { xKey (default 'date'), xLabel (fn, default shortDate) } */
function lineChart(canvasId, data, series, opts) {
  opts = opts || {};
  var xKey = opts.xKey || 'date';
  var xLabel = opts.xLabel || shortDate;
  var tc = themeColors();
  var cfg = {
    type: 'line',
    data: {
      labels: data.map(function (d) { return xLabel(d[xKey]); }),
      datasets: series.map(function (s) {
        return {
          label: s.label, data: data.map(function (d) { return d[s.key]; }),
          borderColor: s.color, backgroundColor: s.color, tension: 0.3,
          pointRadius: 0, pointHoverRadius: 4, borderWidth: 2,
        };
      }),
    },
    options: _baseOptions(tc),
  };
  _make(canvasId, cfg);
}

/* Bar chart. horizontal=true for a category-on-y layout. */
function barChart(canvasId, labels, values, opts2) {
  opts2 = opts2 || {};
  var tc = themeColors();
  var base = _baseOptions(tc);
  base.plugins.legend.display = false;
  if (opts2.horizontal) base.indexAxis = 'y';
  _make(canvasId, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        data: values,
        backgroundColor: opts2.colors || tc.accent,
        borderRadius: 6, maxBarThickness: 46,
      }],
    },
    options: base,
  });
}

/* Doughnut/pie chart. items: [{label,value}] */
function pieChart(canvasId, items) {
  var tc = themeColors();
  _make(canvasId, {
    type: 'doughnut',
    data: {
      labels: items.map(function (i) { return i.label; }),
      datasets: [{ data: items.map(function (i) { return i.value; }),
        backgroundColor: PALETTE, borderColor: tc.surface, borderWidth: 2 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: { legend: { position: 'bottom', labels: { color: tc.text, usePointStyle: true, boxWidth: 8, padding: 12 } } },
    },
  });
}

function _make(canvasId, cfg) {
  if (_charts[canvasId]) _charts[canvasId].destroy();
  var el = document.getElementById(canvasId);
  if (!el) return;
  _charts[canvasId] = new Chart(el.getContext('2d'), cfg);
}

/* ---------- Chart / table view toggle for the main trend ----------
   Expects, in the HTML: a .segmented with data-view buttons ("chart"/"table"),
   an element #<baseId>-chart (the chart-box) and #<baseId>-table (table box). */
function wireViewToggle(baseId, buildTable) {
  var seg = document.querySelector('[data-view-for="' + baseId + '"]');
  if (!seg) return;
  seg.querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () {
      seg.querySelectorAll('button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      var view = b.getAttribute('data-view');
      document.getElementById(baseId + '-chart').hidden = view !== 'chart';
      var tableBox = document.getElementById(baseId + '-table');
      tableBox.hidden = view !== 'table';
      if (view === 'table') buildTable();
    });
  });
}

/* ---------- Page bootstrap ---------- */
/* Call initPage('sales', renderFn). renderFn(data) is called on load, on range
   change, and on theme toggle (with cached data for theme). */
function initPage(area, renderFn) {
  if (!requireLogin()) return;

  // top bar
  var u = currentUser();
  var nameEl = document.getElementById('userName');
  if (nameEl) nameEl.textContent = u ? (u.name || u.email) : '';
  var logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);
  var themeBtn = document.getElementById('themeBtn');
  if (themeBtn) {
    var syncLabel = function () { themeBtn.textContent = currentTheme() === 'dark' ? '☀ Light' : '☾ Dark'; };
    syncLabel();
    themeBtn.addEventListener('click', function () { toggleTheme(); syncLabel(); });
  }

  var cache = null;

  // date range toggle
  var rangeSeg = document.getElementById('rangeToggle');
  if (rangeSeg) {
    var r = getRange();
    rangeSeg.querySelectorAll('button').forEach(function (b) {
      if (b.getAttribute('data-range') === r) b.classList.add('active');
      b.addEventListener('click', function () {
        rangeSeg.querySelectorAll('button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        setRange(b.getAttribute('data-range'));
        load();
      });
    });
  }

  // re-render charts (with cached data) when the theme changes
  window.onThemeChange = function () { if (cache) renderFn(cache); };

  function load() {
    fetchMetrics(area, getRange())
      .then(function (data) { cache = data; renderFn(data); })
      .catch(function (err) { console.error(err); });
  }
  // Pages that render their own data (no metrics payload) call initPage with no
  // renderFn — skip the /api/metrics/:area fetch for them.
  if (renderFn) load();
}
