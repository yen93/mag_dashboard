// Marketing — Facebook Page audience demographics, from a manual CSV import (Social Platforms tab).
//
// Facebook Page follower demographics (page_fans_gender_age / _city / _country) were RETIRED by
// Meta's New-Pages API with no Graph API replacement (verified live 2026-11-27). So — exactly
// like the LinkedIn Analytics import — a team member exports the "Audience" CSV from Meta Business
// Suite and uploads it from the Facebook tab. We parse it, upsert the single MAG Facebook Page row
// into public.meta_fb_audience_import, and the "Audience — who follows us" card reads it back.
//
// The export is a small UTF-16 CSV with three sections:
//   sep=,
//   "Age & gender"
//   "","Women","Men"
//   "18-24","0.2","0.3"            ...rows per bracket (% of audience)
//   "Top cities"
//   "<city>","<city>",...          names row
//   "<pct>","<pct>",...            % share row
//   "Top countries"               (same shape as cities)
//
// Server-side only (reads/writes via the pooled owner connection). UPSERT-only, never truncated.

import { q, supabaseConfigured } from '../providers/supabase.js';

const PAGE_KEY = 'mag_facebook';

const SRC =
  'Imported Facebook Audience CSV (Meta Business Suite → public.meta_fb_audience_import): follower ' +
  'age & gender, top cities and top countries. Facebook Page demographics are retired from Meta\'s ' +
  'Graph API, so this is a manual export uploaded from the Facebook tab.';

// ── CSV parsing ─────────────────────────────────────────────────────────────

// Decode a base64 upload to text, honouring a UTF-16 (LE/BE) or UTF-8 BOM (the Meta export is
// UTF-16LE with a BOM); falls back to UTF-8.
function decodeCsv(base64) {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  return buf.toString('utf8');
}

// Split one CSV line into trimmed fields (handles quoted fields with embedded commas and "" escapes).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; }
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const toNum = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function zipShares(names, vals) {
  if (!names) return [];
  return names
    .map((n, k) => ({ place: String(n || '').trim(), share: toNum(vals && vals[k]) }))
    .filter((r) => r.place && r.share != null);
}

// Next two non-blank rows (names + values) starting at `start`; returns [names, vals, indexAfter].
function nextTwoRows(rows, start) {
  const found = [];
  let i = start;
  for (; i < rows.length && found.length < 2; i++) {
    if (rows[i]) found.push(rows[i]);
  }
  return [found[0] || null, found[1] || null, i];
}

export function parseAudienceCsv(text) {
  const rawLines = String(text || '').split(/\r\n|\n|\r/);
  const rows = [];
  for (const ln of rawLines) {
    const t = ln.trim();
    if (!t) { rows.push(null); continue; }       // blank marker (separates sections)
    if (/^sep\s*=/i.test(t)) continue;           // skip the "sep=," hint line
    rows.push(parseCsvLine(ln));
  }

  const result = { ageGender: [], locations: [], countries: [] };
  const firstCell = (r) => (r && r[0] != null ? String(r[0]).trim() : '');

  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (!r) { i++; continue; }
    const h = firstCell(r).toLowerCase();

    if (h === 'age & gender' || h === 'age and gender' || h === 'age&gender') {
      i++;
      while (i < rows.length && rows[i]) {
        const rr = rows[i];
        const label = firstCell(rr);
        const low = label.toLowerCase();
        if (low === '' || low === 'women' || low === 'men') { i++; continue; }   // header-ish row
        if (/^\d/.test(label) || /\+\s*$/.test(label)) {                          // "18-24" ... "65+"
          result.ageGender.push({ age: label, female: toNum(rr[1]) || 0, male: toNum(rr[2]) || 0 });
          i++;
        } else break;
      }
      continue;
    }

    if (h === 'top cities' || h === 'top locations' || h === 'cities') {
      const [names, vals, ni] = nextTwoRows(rows, i + 1);
      result.locations = zipShares(names, vals);
      i = ni;
      continue;
    }

    if (h === 'top countries' || h === 'countries') {
      const [names, vals, ni] = nextTwoRows(rows, i + 1);
      result.countries = zipShares(names, vals);
      i = ni;
      continue;
    }

    i++;
  }
  return result;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function getMetaFbAudience() {
  if (!supabaseConfigured()) {
    return { ageGender: [], locations: [], countries: [], meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' } };
  }
  const rows = await q(
    `select file_name, age_gender, locations, countries, uploaded_at, uploaded_by
       from public.meta_fb_audience_import where page_key = $1`,
    [PAGE_KEY],
  );
  const row = rows && rows[0];
  const ageGender = (row && row.age_gender) || [];
  const locations = (row && row.locations) || [];
  const countries = (row && row.countries) || [];
  const live = ageGender.length > 0 || locations.length > 0 || countries.length > 0;
  return {
    ageGender,
    locations,
    countries,
    fileName: row ? row.file_name : null,
    uploadedAt: row ? row.uploaded_at : null,
    uploadedBy: row ? row.uploaded_by : null,
    meta: {
      status: live ? 'live' : 'pending',
      source: SRC,
      note: live
        ? `Imported Facebook audience${row && row.file_name ? ' from ' + row.file_name : ''}.`
        : 'No Facebook audience CSV imported yet.',
    },
  };
}

export async function saveMetaFbAudienceImport(files, email) {
  if (!supabaseConfigured()) {
    const e = new Error('Database not configured — cannot store the import.');
    e.status = 503;
    throw e;
  }
  const list = Array.isArray(files) ? files : [];
  if (!list.length) {
    const e = new Error('No file provided.');
    e.status = 400;
    throw e;
  }

  // Parse each file; later files override a section only when they carry data (merge, last-wins).
  const merged = { ageGender: [], locations: [], countries: [] };
  let fileName = null;
  for (const f of list) {
    const name = (f && f.fileName) || 'audience.csv';
    let parsed;
    try {
      parsed = parseAudienceCsv(decodeCsv(f && f.base64));
    } catch {
      continue;
    }
    if (parsed.ageGender.length) merged.ageGender = parsed.ageGender;
    if (parsed.locations.length) merged.locations = parsed.locations;
    if (parsed.countries.length) merged.countries = parsed.countries;
    if (parsed.ageGender.length || parsed.locations.length || parsed.countries.length) fileName = name;
  }

  if (!merged.ageGender.length && !merged.locations.length && !merged.countries.length) {
    const e = new Error('Could not read any Age & gender / Top cities / Top countries data from the CSV. Expected a Meta Business Suite Audience export.');
    e.status = 400;
    throw e;
  }

  await q(
    `insert into public.meta_fb_audience_import
       (page_key, file_name, age_gender, locations, countries, uploaded_by, uploaded_at, updated_at)
     values ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, now(), now())
     on conflict (page_key) do update
       set file_name = excluded.file_name,
           age_gender = excluded.age_gender,
           locations = excluded.locations,
           countries = excluded.countries,
           uploaded_by = excluded.uploaded_by,
           updated_at = now()`,
    [PAGE_KEY, fileName, JSON.stringify(merged.ageGender), JSON.stringify(merged.locations), JSON.stringify(merged.countries), email || null],
  );
  await q(
    `insert into public.meta_fb_audience_import_log (page_key, file_name, uploaded_by) values ($1, $2, $3)`,
    [PAGE_KEY, fileName, email || null],
  );

  return {
    ageGender: merged.ageGender,
    locations: merged.locations,
    countries: merged.countries,
    fileName,
    uploadedAt: new Date().toISOString(),
    uploadedBy: email || null,
    summary: {
      ageGenderRows: merged.ageGender.length,
      cityRows: merged.locations.length,
      countryRows: merged.countries.length,
    },
  };
}
