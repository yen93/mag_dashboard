// Marketing — LinkedIn Analytics manual .xlsx / .xls import (Personal LinkedIn & MAG LinkedIn).
//
// Parses:
//   - Personal LinkedIn AggregateAnalytics_*.xlsx (DISCOVERY, ENGAGEMENT, TOP POSTS, FOLLOWERS, DEMOGRAPHICS)
//   - MAG LinkedIn Company Page exports (.xls BIFF8 & .xlsx):
//       * followers (.xls): New followers + follower Location / Job function / Seniority / Industry / Company size
//       * visitors (.xls): Visitor metrics (desktop/mobile page views & unique visitors) + visitor demographics
//       * content (.xls): Metrics (daily impressions, unique impressions, clicks, reactions, comments, reposts) + All posts
//       * competitor_analytics (.xlsx): COMPETITORS sheet
//
// Persists the merged normalized state per platform_key in public.linkedin_analytics_imports.
//
// Backs:
//   GET  /api/marketing/linkedin-analytics
//   POST /api/marketing/linkedin-analytics/import

import { q, supabaseConfigured } from '../providers/supabase.js';
import { parseXlsxBuffer } from '../lib/xlsx-parser.js';
import { parseXlsBuffer } from '../lib/xls-parser.js';

export const ALLOWED_LINKEDIN_PLATFORMS = ['james_linkedin', 'mag_linkedin'];

const SRC =
  'Imported LinkedIn Analytics (.xlsx / .xls) stored in public.linkedin_analytics_imports — ' +
  'covers impressions, members reached, daily engagement, daily new followers, visitor page views, ' +
  'top posts, competitor benchmarks, and audience demographics for Personal LinkedIn and MAG LinkedIn.';

// ── Value parsing helpers ────────────────────────────────────────────────────

function cleanStr(v) {
  return v == null ? '' : String(v).trim();
}

function parseIntSafe(v) {
  if (v == null || v === '') return null;
  const cleaned = String(v).replace(/,/g, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function parseNumSafe(v) {
  if (v == null || v === '') return null;
  const cleaned = String(v).replace(/,/g, '').replace(/%$/, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseDateToIso(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const m = parseInt(mdy[1], 10);
    const d = parseInt(mdy[2], 10);
    const y = parseInt(mdy[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 30000 && serial < 70000) {
      const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
      return new Date(ms).toISOString().slice(0, 10);
    }
  }

  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}

function parsePctValue(raw) {
  const s = cleanStr(raw);
  if (!s) return { pct: null, rawPct: '' };
  if (/^<\s*1\s*%?$/i.test(s)) return { pct: 0.5, rawPct: '< 1%' };
  const n = parseNumSafe(s);
  if (n == null) return { pct: null, rawPct: s };
  const pct = !s.includes('%') && n > 0 && n <= 1 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10;
  return { pct, rawPct: s.includes('%') ? s : `${pct}%` };
}

function titleFromPostUrl(url) {
  const u = cleanStr(url);
  if (!u) return 'LinkedIn post';
  const m = u.match(/linkedin\.com\/(?:posts|feed\/update)\/([^/?#]+)/i);
  if (!m) return u;
  let slug = decodeURIComponent(m[1]);
  const usIdx = slug.indexOf('_');
  if (usIdx !== -1) slug = slug.slice(usIdx + 1);
  slug = slug.replace(/-(?:ugcPost|share|activity)-\d+.*$/i, '');
  slug = slug.replace(/[-_]+/g, ' ').trim();
  if (!slug) return 'LinkedIn post';
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function cleanPostTitle(raw, fallbackUrl) {
  const s = cleanStr(raw).replace(/\s+/g, ' ');
  if (!s) return titleFromPostUrl(fallbackUrl);
  return s.length > 110 ? s.slice(0, 107).trimEnd() + '…' : s;
}

function findSheet(sheets, candidates) {
  const keys = Object.keys(sheets);
  for (const cand of candidates) {
    const exact = keys.find((k) => k.trim().toLowerCase() === cand.toLowerCase());
    if (exact) return sheets[exact];
  }
  for (const cand of candidates) {
    const partial = keys.find((k) => k.trim().toLowerCase().includes(cand.toLowerCase()));
    if (partial) return sheets[partial];
  }
  return null;
}

function parseSpreadsheetBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    throw new Error('Uploaded file is empty or too small.');
  }
  // OLE2 BIFF8 (.xls): D0 CF 11 E0 A1 B1 1A E1
  if (buffer.readUInt32BE(0) === 0xd0cf11e0 && buffer.readUInt32BE(4) === 0xa1b11ae1) {
    return parseXlsBuffer(buffer);
  }
  // ZIP / OOXML (.xlsx): PK\x03\x04
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    return parseXlsxBuffer(buffer);
  }
  throw new Error('Unsupported file format. Please upload LinkedIn .xlsx or .xls export files.');
}

// ── Workbook parser ──────────────────────────────────────────────────────────

export function parseLinkedInWorkbook(buffer, fileName = '') {
  const { sheetNames, sheets } = parseSpreadsheetBuffer(buffer);

  let dateStart = null;
  let dateEnd = null;
  let dateRangeLabel = null;
  let totalFollowers = null;
  let totalFollowersDate = null;
  const discovery = {};
  const dailyEngagementMap = new Map();
  const dailyFollowersMap = new Map();
  const dailyVisitorsMap = new Map();
  const topPostsMap = new Map();
  const demographics = {
    seniority: [],
    industry: [],
    location: [],
    jobTitle: [],
    companySize: [],
    company: [],
  };
  const pageMetrics = {};

  // 1. DISCOVERY sheet (Personal AggregateAnalytics format)
  const discoveryRows = findSheet(sheets, ['DISCOVERY']);
  if (discoveryRows) {
    for (const row of discoveryRows) {
      if (!row || !row.length) continue;
      const k = cleanStr(row[0]).toLowerCase();
      const v = cleanStr(row[1]);
      if (k.includes('overall performance') && v) {
        dateRangeLabel = v;
        const parts = v.split(/\s*-\s*/);
        if (parts.length === 2) {
          dateStart = parseDateToIso(parts[0]) || dateStart;
          dateEnd = parseDateToIso(parts[1]) || dateEnd;
        }
      } else if (k === 'impressions') {
        discovery.impressions = parseIntSafe(v);
      } else if (k.includes('members reached')) {
        discovery.membersReached = parseIntSafe(v);
      }
    }
  }

  // 2. ENGAGEMENT sheet (Personal) or Metrics sheet (Company Page Content .xls)
  const engagementRows = findSheet(sheets, ['ENGAGEMENT', 'Metrics']);
  if (engagementRows) {
    let headerIdx = -1;
    let headers = [];
    for (let i = 0; i < Math.min(engagementRows.length, 10); i++) {
      const r = (engagementRows[i] || []).map((c) => cleanStr(c).toLowerCase());
      if (r.includes('date') && (r.some((h) => h.includes('impression')) || r.some((h) => h.includes('engagement')))) {
        headerIdx = i;
        headers = r;
        break;
      }
    }
    if (headerIdx >= 0) {
      const dateCol = headers.findIndex((h) => h === 'date');
      const impCol = headers.findIndex((h) => h === 'impressions (total)' || h === 'impressions' || h === 'impressions (organic)');
      const uniqImpCol = headers.findIndex((h) => h.includes('unique impressions'));
      const engCol = headers.findIndex((h) => h === 'engagements' || h === 'engagements (total)');
      const reactCol = headers.findIndex((h) => h === 'reactions (total)' || h === 'reactions');
      const commCol = headers.findIndex((h) => h === 'comments (total)' || h === 'comments');
      const repCol = headers.findIndex((h) => h === 'reposts (total)' || h === 'reposts');
      const clickCol = headers.findIndex((h) => h === 'clicks (total)' || h === 'clicks');

      let sumReact = 0, sumComm = 0, sumRep = 0, sumClicks = 0, sumUniq = 0;
      let hasPageBreakdown = false;

      for (let i = headerIdx + 1; i < engagementRows.length; i++) {
        const r = engagementRows[i];
        if (!r || !r.length) continue;
        const iso = parseDateToIso(r[dateCol]);
        if (!iso) continue;
        const imp = impCol >= 0 ? (parseIntSafe(r[impCol]) || 0) : 0;
        let eng = engCol >= 0 ? (parseIntSafe(r[engCol]) || 0) : 0;
        const rowObj = { date: iso, impressions: imp, engagements: eng };

        if (reactCol >= 0 || commCol >= 0 || repCol >= 0 || clickCol >= 0) {
          hasPageBreakdown = true;
          const re = reactCol >= 0 ? (parseIntSafe(r[reactCol]) || 0) : 0;
          const co = commCol >= 0 ? (parseIntSafe(r[commCol]) || 0) : 0;
          const rp = repCol >= 0 ? (parseIntSafe(r[repCol]) || 0) : 0;
          const cl = clickCol >= 0 ? (parseIntSafe(r[clickCol]) || 0) : 0;
          const uq = uniqImpCol >= 0 ? (parseIntSafe(r[uniqImpCol]) || 0) : 0;
          sumReact += re;
          sumComm += co;
          sumRep += rp;
          sumClicks += cl;
          sumUniq += uq;
          rowObj.reactions = re;
          rowObj.comments = co;
          rowObj.reposts = rp;
          rowObj.clicks = cl;
          if (uniqImpCol >= 0) rowObj.uniqueImpressions = uq;
          if (engCol < 0) rowObj.engagements = re + co + rp + cl;
        }

        dailyEngagementMap.set(iso, rowObj);
      }

      if (hasPageBreakdown) {
        pageMetrics.reactions = sumReact;
        pageMetrics.comments = sumComm;
        pageMetrics.reposts = sumRep;
        if (clickCol >= 0) pageMetrics.clicks = sumClicks;
        if (uniqImpCol >= 0) pageMetrics.uniqueImpressions = sumUniq;
      }
    }
  }

  // 3. TOP POSTS (Personal dual-table) or All posts (Company Page Content .xls)
  const topPostsRows = findSheet(sheets, ['TOP POSTS', 'All posts']);
  if (topPostsRows) {
    let dualHeaderIdx = -1;
    let singleHeaderIdx = -1;
    let singleHeaders = [];

    for (let i = 0; i < Math.min(topPostsRows.length, 10); i++) {
      const r = (topPostsRows[i] || []).map((c) => cleanStr(c).toLowerCase());
      if (r[0] === 'post url' && r[4] === 'post url') {
        dualHeaderIdx = i;
        break;
      }
      if (r.some((h) => h.includes('post link') || h === 'post url') && r.some((h) => h.includes('impression') || h.includes('engagement'))) {
        singleHeaderIdx = i;
        singleHeaders = r;
        break;
      }
    }

    if (dualHeaderIdx >= 0) {
      for (let i = dualHeaderIdx + 1; i < topPostsRows.length; i++) {
        const r = topPostsRows[i];
        if (!r || !r.length) continue;

        const leftUrl = cleanStr(r[0]);
        if (leftUrl && leftUrl.startsWith('http')) {
          const existing = topPostsMap.get(leftUrl) || {
            url: leftUrl,
            post: titleFromPostUrl(leftUrl),
            publishDate: parseDateToIso(r[1]),
            impressions: null,
            engagements: null,
          };
          existing.publishDate = existing.publishDate || parseDateToIso(r[1]);
          existing.engagements = parseIntSafe(r[2]);
          topPostsMap.set(leftUrl, existing);
        }

        const rightUrl = cleanStr(r[4]);
        if (rightUrl && rightUrl.startsWith('http')) {
          const existing = topPostsMap.get(rightUrl) || {
            url: rightUrl,
            post: titleFromPostUrl(rightUrl),
            publishDate: parseDateToIso(r[5]),
            impressions: null,
            engagements: null,
          };
          existing.publishDate = existing.publishDate || parseDateToIso(r[5]);
          existing.impressions = parseIntSafe(r[6]);
          topPostsMap.set(rightUrl, existing);
        }
      }
    } else if (singleHeaderIdx >= 0) {
      const urlCol = singleHeaders.findIndex((h) => h.includes('post link') || h === 'post url');
      const titleCol = singleHeaders.findIndex((h) => h.includes('post title'));
      const dateCol = singleHeaders.findIndex((h) => h.includes('created date') || h.includes('publish date') || h === 'date');
      const impCol = singleHeaders.findIndex((h) => h === 'impressions');
      const likesCol = singleHeaders.findIndex((h) => h === 'likes' || h === 'reactions');
      const commCol = singleHeaders.findIndex((h) => h === 'comments');
      const repCol = singleHeaders.findIndex((h) => h === 'reposts');
      const clicksCol = singleHeaders.findIndex((h) => h === 'clicks');
      const engCol = singleHeaders.findIndex((h) => h === 'engagements');
      const contentTypeCol = singleHeaders.findIndex((h) => h === 'content type');

      for (let i = singleHeaderIdx + 1; i < topPostsRows.length; i++) {
        const r = topPostsRows[i];
        if (!r || !r.length) continue;
        const url = urlCol >= 0 ? cleanStr(r[urlCol]) : '';
        if (!url) continue;
        const title = cleanPostTitle(titleCol >= 0 ? r[titleCol] : '', url);
        const imp = impCol >= 0 ? parseIntSafe(r[impCol]) : null;
        const likes = likesCol >= 0 ? (parseIntSafe(r[likesCol]) || 0) : 0;
        const comments = commCol >= 0 ? (parseIntSafe(r[commCol]) || 0) : 0;
        const reposts = repCol >= 0 ? (parseIntSafe(r[repCol]) || 0) : 0;
        const clicks = clicksCol >= 0 ? parseIntSafe(r[clicksCol]) : null;
        let eng = engCol >= 0 ? parseIntSafe(r[engCol]) : null;
        if (eng == null) {
          eng = likes + comments + reposts + (clicks || 0);
        }
        const rawCt = contentTypeCol >= 0 ? cleanStr(r[contentTypeCol]) : '';
        const contentType = rawCt || 'Post';
        topPostsMap.set(url, {
          url,
          post: title,
          publishDate: dateCol >= 0 ? parseDateToIso(r[dateCol]) : null,
          impressions: imp,
          engagements: eng,
          likes,
          comments,
          reposts,
          linkClicks: clicks,
          contentType,
        });
      }
    }
  }

  // 4. FOLLOWERS (Personal) or New followers (Company Page Followers .xls)
  const followersRows = findSheet(sheets, ['FOLLOWERS', 'New followers']);
  if (followersRows) {
    let headerIdx = -1;
    let headers = [];
    for (let i = 0; i < Math.min(followersRows.length, 10); i++) {
      const r = followersRows[i] || [];
      const first = cleanStr(r[0]);
      const totMatch = first.match(/total followers(?:\s+on\s+(.+))?/i);
      if (totMatch && r[1] != null) {
        totalFollowers = parseIntSafe(r[1]);
        if (totMatch[1]) totalFollowersDate = parseDateToIso(totMatch[1]);
      }
      const lower = r.map((c) => cleanStr(c).toLowerCase());
      if (lower.includes('date') && lower.some((h) => h.includes('follower'))) {
        headerIdx = i;
        headers = lower;
        break;
      }
    }
    if (headerIdx >= 0) {
      const dateCol = headers.findIndex((h) => h === 'date');
      const newCol = headers.findIndex((h) => h === 'new followers' || h === 'total followers' || h.includes('organic followers'));
      const orgCol = headers.findIndex((h) => h.includes('organic followers'));
      const sponCol = headers.findIndex((h) => h.includes('sponsored followers'));
      for (let i = headerIdx + 1; i < followersRows.length; i++) {
        const r = followersRows[i];
        if (!r || !r.length) continue;
        const iso = parseDateToIso(r[dateCol]);
        if (!iso) continue;
        const nf = newCol >= 0 ? (parseIntSafe(r[newCol]) || 0) : 0;
        const obj = { date: iso, newFollowers: nf };
        if (orgCol >= 0) obj.organicFollowers = parseIntSafe(r[orgCol]) || 0;
        if (sponCol >= 0) obj.sponsoredFollowers = parseIntSafe(r[sponCol]) || 0;
        dailyFollowersMap.set(iso, obj);
      }
    }
  }

  // 5. DEMOGRAPHICS (Personal single sheet OR Company Page separate sheets)
  const demoRows = findSheet(sheets, ['DEMOGRAPHICS']);
  if (demoRows) {
    const catMap = {
      seniority: 'seniority',
      industry: 'industry',
      location: 'location',
      'job title': 'jobTitle',
      'job function': 'jobTitle',
      'company size': 'companySize',
      company: 'company',
    };
    for (let i = 1; i < demoRows.length; i++) {
      const r = demoRows[i];
      if (!r || r.length < 2) continue;
      const rawCat = cleanStr(r[0]).toLowerCase();
      const targetKey = catMap[rawCat];
      if (!targetKey) continue;
      const label = cleanStr(r[1]);
      if (!label) continue;
      const { pct, rawPct } = parsePctValue(r[2]);
      demographics[targetKey].push({ label, pct, rawPct });
    }
  } else {
    // Company Page exports have separate sheets: Location, Seniority, Industry, Company size, Job function.
    // Distinguish FOLLOWER demographics ("Total followers") from VISITOR demographics ("Total views").
    const pageDemoSheets = [
      ['Seniority', 'seniority'],
      ['Industry', 'industry'],
      ['Location', 'location'],
      ['Job function', 'jobTitle'],
      ['Company size', 'companySize'],
    ];
    const visitorDemo = {};
    for (const [sheetKey, targetKey] of pageDemoSheets) {
      const rows = findSheet(sheets, [sheetKey]);
      if (!rows || rows.length < 2) continue;
      const metricHeader = cleanStr(rows[0] && rows[0][1]).toLowerCase();
      const isVisitorDemo = metricHeader.includes('view');
      const rawItems = [];
      let totalCount = 0;
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !cleanStr(r[0])) continue;
        const count = parseNumSafe(r[1]);
        if (count == null || count <= 0) continue;
        rawItems.push({ label: cleanStr(r[0]), count });
        totalCount += count;
      }
      if (totalCount > 0) {
        rawItems.sort((a, b) => b.count - a.count);
        const topItems = rawItems.slice(0, 10).map((it) => {
          const pct = Math.round((it.count / totalCount) * 1000) / 10;
          return { label: it.label, pct, rawPct: `${pct}%`, count: Math.round(it.count) };
        });
        if (isVisitorDemo) visitorDemo[targetKey] = topItems;
        else demographics[targetKey] = topItems;
      }
    }
    if (Object.keys(visitorDemo).length) {
      pageMetrics.visitorDemographics = visitorDemo;
    }
  }

  // 6. Visitor metrics sheet (Company Page Visitors .xls)
  const visitorRows = findSheet(sheets, ['Visitor metrics']);
  if (visitorRows && visitorRows.length > 1) {
    const h = (visitorRows[0] || []).map((c) => cleanStr(c).toLowerCase());
    const dateCol = h.findIndex((x) => x === 'date');
    const pvCol = h.findIndex((x) => x === 'total page views (total)' || x === 'overview page views (total)');
    const pvDeskCol = h.findIndex((x) => x === 'total page views (desktop)' || x === 'overview page views (desktop)');
    const pvMobCol = h.findIndex((x) => x === 'total page views (mobile)' || x === 'overview page views (mobile)');
    const uvCol = h.findIndex((x) => x === 'total unique visitors (total)' || x === 'overview unique visitors (total)');
    const btnCol = h.findIndex((x) => x.includes('custom button clicks'));

    let pv = 0, pvDesk = 0, pvMob = 0, uv = 0, btn = 0;
    for (let i = 1; i < visitorRows.length; i++) {
      const r = visitorRows[i];
      if (!r || !r.length) continue;
      const iso = dateCol >= 0 ? parseDateToIso(r[dateCol]) : null;
      const dPv = pvCol >= 0 ? (parseIntSafe(r[pvCol]) || 0) : 0;
      const dDesk = pvDeskCol >= 0 ? (parseIntSafe(r[pvDeskCol]) || 0) : 0;
      const dMob = pvMobCol >= 0 ? (parseIntSafe(r[pvMobCol]) || 0) : 0;
      const dUv = uvCol >= 0 ? (parseIntSafe(r[uvCol]) || 0) : 0;
      const dBtn = btnCol >= 0 ? (parseIntSafe(r[btnCol]) || 0) : 0;
      pv += dPv;
      pvDesk += dDesk;
      pvMob += dMob;
      uv += dUv;
      btn += dBtn;
      if (iso) {
        dailyVisitorsMap.set(iso, {
          date: iso,
          pageViews: dPv,
          uniqueVisitors: dUv,
          desktopViews: dDesk,
          mobileViews: dMob,
          customButtonClicks: btnCol >= 0 ? dBtn : null,
        });
      }
    }
    if (pvCol >= 0) pageMetrics.pageViews = pv;
    if (pvDeskCol >= 0) pageMetrics.desktopViews = pvDesk;
    if (pvMobCol >= 0) pageMetrics.mobileViews = pvMob;
    if (uvCol >= 0) pageMetrics.uniqueVisitors = uv;
    if (btnCol >= 0) pageMetrics.customButtonClicks = btn;
    if (dailyVisitorsMap.size) {
      pageMetrics.dailyVisitors = Array.from(dailyVisitorsMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  // 7. COMPETITORS sheet (Company Page competitor_analytics .xlsx)
  const compRows = findSheet(sheets, ['COMPETITORS']);
  if (compRows && compRows.length >= 2) {
    let compStart = null;
    let compEnd = null;
    let headerIdx = -1;
    let headers = [];

    for (let i = 0; i < Math.min(compRows.length, 6); i++) {
      const r = compRows[i] || [];
      const lower = r.map((c) => cleanStr(c).toLowerCase());
      if (lower.includes('page') && (lower.includes('new followers') || lower.includes('posts'))) {
        headerIdx = i;
        headers = lower;
        break;
      }
      if (i === 0 && parseDateToIso(r[0]) && parseDateToIso(r[1])) {
        compStart = parseDateToIso(r[0]);
        compEnd = parseDateToIso(r[1]);
      }
    }

    if (headerIdx >= 0) {
      const pageCol = headers.findIndex((h) => h === 'page');
      const nfCol = headers.findIndex((h) => h.includes('new followers'));
      const postsCol = headers.findIndex((h) => h === 'posts');
      const commCol = headers.findIndex((h) => h === 'comments');
      const cpdCol = headers.findIndex((h) => h.includes('comments per day'));
      const reactCol = headers.findIndex((h) => h === 'reactions');

      const rows = [];
      for (let i = headerIdx + 1; i < compRows.length; i++) {
        const r = compRows[i];
        if (!r || !cleanStr(r[pageCol])) continue;
        rows.push({
          page: cleanStr(r[pageCol]),
          newFollowers: nfCol >= 0 ? parseIntSafe(r[nfCol]) : null,
          posts: postsCol >= 0 ? parseIntSafe(r[postsCol]) : null,
          comments: commCol >= 0 ? parseIntSafe(r[commCol]) : null,
          commentsPerDay: cpdCol >= 0 ? parseNumSafe(r[cpdCol]) : null,
          reactions: reactCol >= 0 ? parseIntSafe(r[reactCol]) : null,
        });
      }
      if (rows.length) {
        pageMetrics.competitors = {
          dateStart: compStart,
          dateEnd: compEnd,
          rows,
        };
        if (!dateStart && compStart) dateStart = compStart;
        if (!dateEnd && compEnd) dateEnd = compEnd;
      }
    }
  }

  // Sort daily series ascending
  const dailyEngagement = Array.from(dailyEngagementMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  const dailyFollowers = Array.from(dailyFollowersMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  const allDates = [
    ...dailyEngagement.map((d) => d.date),
    ...dailyFollowers.map((d) => d.date),
    ...(pageMetrics.dailyVisitors || []).map((d) => d.date),
  ].sort();
  if (!dateStart && allDates.length) dateStart = allDates[0];
  if (!dateEnd && allDates.length) dateEnd = allDates[allDates.length - 1];
  if (!dateRangeLabel && dateStart && dateEnd) dateRangeLabel = `${dateStart} – ${dateEnd}`;

  if (discovery.impressions == null && dailyEngagement.length) {
    discovery.impressions = dailyEngagement.reduce((s, d) => s + (d.impressions || 0), 0);
  }
  if (dailyEngagement.length) {
    discovery.engagements = dailyEngagement.reduce((s, d) => s + (d.engagements || 0), 0);
  }

  const topPosts = Array.from(topPostsMap.values()).map((p) => {
    const engRate = p.impressions && p.impressions > 0 && p.engagements != null
      ? Math.round((p.engagements / p.impressions) * 1000) / 10
      : null;
    return { ...p, engRate };
  }).sort((a, b) => (b.engagements || 0) - (a.engagements || 0) || (b.impressions || 0) - (a.impressions || 0));

  const demoCount = Object.values(demographics).reduce((s, arr) => s + arr.length, 0);

  if (
    !dailyEngagement.length &&
    !dailyFollowers.length &&
    !topPosts.length &&
    !demoCount &&
    totalFollowers == null &&
    !Object.keys(pageMetrics).length
  ) {
    throw new Error('Could not find recognizable LinkedIn Analytics sheets in this workbook.');
  }

  return {
    fileName: cleanStr(fileName) || 'linkedin_analytics.xlsx',
    dateStart,
    dateEnd,
    dateRangeLabel,
    totalFollowers,
    totalFollowersDate: totalFollowersDate || dateEnd,
    discovery,
    dailyEngagement,
    dailyFollowers,
    topPosts,
    demographics,
    pageMetrics,
    summary: {
      sheets: sheetNames,
      engagementDays: dailyEngagement.length,
      followerDays: dailyFollowers.length,
      visitorDays: (pageMetrics.dailyVisitors || []).length,
      topPostsCount: topPosts.length,
      demographicsCount: demoCount,
      competitorsCount: (pageMetrics.competitors && pageMetrics.competitors.rows) ? pageMetrics.competitors.rows.length : 0,
    },
  };
}

// Merge multiple parsed workbooks (and/or existing DB state) so uploading followers,
// visitors, content, and competitor exports together OR one-by-one combines cleanly.
export function mergeLinkedInWorkbooks(parsedList) {
  const valid = (parsedList || []).filter(Boolean);
  if (valid.length === 1) return valid[0];

  const base = {
    fileName: '',
    dateStart: null,
    dateEnd: null,
    dateRangeLabel: null,
    totalFollowers: null,
    totalFollowersDate: null,
    discovery: {},
    dailyEngagement: [],
    dailyFollowers: [],
    topPosts: [],
    demographics: { seniority: [], industry: [], location: [], jobTitle: [], companySize: [], company: [] },
    pageMetrics: {},
    summary: { sheets: [], engagementDays: 0, followerDays: 0, visitorDays: 0, topPostsCount: 0, demographicsCount: 0, competitorsCount: 0 },
  };

  const fileNames = new Set();
  const engMap = new Map();
  const folMap = new Map();
  const visMap = new Map();
  const postMap = new Map();
  const sheetSet = new Set();

  for (const p of valid) {
    if (p.fileName) {
      for (const fn of String(p.fileName).split(',')) {
        const clean = fn.trim();
        if (clean) fileNames.add(clean);
      }
    }
    if (p.dateStart && (!base.dateStart || p.dateStart < base.dateStart)) base.dateStart = p.dateStart;
    if (p.dateEnd && (!base.dateEnd || p.dateEnd > base.dateEnd)) base.dateEnd = p.dateEnd;
    if (p.dateRangeLabel) base.dateRangeLabel = p.dateRangeLabel;
    if (p.totalFollowers != null) {
      if (base.totalFollowers == null || (p.totalFollowersDate && (!base.totalFollowersDate || p.totalFollowersDate >= base.totalFollowersDate))) {
        base.totalFollowers = p.totalFollowers;
        base.totalFollowersDate = p.totalFollowersDate;
      }
    }
    if (p.discovery) {
      for (const [k, v] of Object.entries(p.discovery)) {
        if (v != null) base.discovery[k] = v;
      }
    }
    if (p.pageMetrics) {
      for (const [k, v] of Object.entries(p.pageMetrics)) {
        if (k === 'dailyVisitors' && Array.isArray(v)) {
          for (const dv of v) visMap.set(dv.date, dv);
        } else if (v != null) {
          base.pageMetrics[k] = v;
        }
      }
    }
    for (const d of p.dailyEngagement || []) engMap.set(d.date, d);
    for (const d of p.dailyFollowers || []) folMap.set(d.date, d);
    for (const post of p.topPosts || []) {
      const prev = postMap.get(post.url) || {};
      postMap.set(post.url, {
        ...prev,
        ...post,
        impressions: post.impressions != null ? post.impressions : prev.impressions,
        engagements: post.engagements != null ? post.engagements : prev.engagements,
      });
    }
    for (const cat of Object.keys(base.demographics)) {
      if (p.demographics && Array.isArray(p.demographics[cat]) && p.demographics[cat].length) {
        base.demographics[cat] = p.demographics[cat];
      }
    }
    for (const s of (p.summary && p.summary.sheets) || []) sheetSet.add(s);
  }

  base.fileName = Array.from(fileNames).join(', ');
  base.dailyEngagement = Array.from(engMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  base.dailyFollowers = Array.from(folMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  if (visMap.size) {
    base.pageMetrics.dailyVisitors = Array.from(visMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    base.pageMetrics.pageViews = base.pageMetrics.dailyVisitors.reduce((s, d) => s + (d.pageViews || 0), 0);
    base.pageMetrics.uniqueVisitors = base.pageMetrics.dailyVisitors.reduce((s, d) => s + (d.uniqueVisitors || 0), 0);
    base.pageMetrics.desktopViews = base.pageMetrics.dailyVisitors.reduce((s, d) => s + (d.desktopViews || 0), 0);
    base.pageMetrics.mobileViews = base.pageMetrics.dailyVisitors.reduce((s, d) => s + (d.mobileViews || 0), 0);
  }
  if (base.dailyEngagement.length) {
    base.discovery.impressions = base.dailyEngagement.reduce((s, d) => s + (d.impressions || 0), 0);
    base.discovery.engagements = base.dailyEngagement.reduce((s, d) => s + (d.engagements || 0), 0);
  }
  if (base.dateStart && base.dateEnd) {
    base.dateRangeLabel = `${base.dateStart} – ${base.dateEnd}`;
  }

  base.topPosts = Array.from(postMap.values()).map((p) => ({
    ...p,
    engRate: p.impressions && p.impressions > 0 && p.engagements != null
      ? Math.round((p.engagements / p.impressions) * 1000) / 10
      : null,
  })).sort((a, b) => (b.engagements || 0) - (a.engagements || 0) || (b.impressions || 0) - (a.impressions || 0));

  base.summary = {
    sheets: Array.from(sheetSet),
    engagementDays: base.dailyEngagement.length,
    followerDays: base.dailyFollowers.length,
    visitorDays: (base.pageMetrics.dailyVisitors || []).length,
    topPostsCount: base.topPosts.length,
    demographicsCount: Object.values(base.demographics).reduce((s, arr) => s + arr.length, 0),
    competitorsCount: (base.pageMetrics.competitors && base.pageMetrics.competitors.rows) ? base.pageMetrics.competitors.rows.length : 0,
  };

  return base;
}

// ── Database reads & writes ──────────────────────────────────────────────────

function rowToApi(r) {
  return {
    platformKey: r.platform_key,
    fileName: r.file_name,
    dateStart: r.date_start ? String(r.date_start).slice(0, 10) : null,
    dateEnd: r.date_end ? String(r.date_end).slice(0, 10) : null,
    dateRangeLabel: r.date_range_label,
    totalFollowers: r.total_followers == null ? null : Number(r.total_followers),
    totalFollowersDate: r.total_followers_date ? String(r.total_followers_date).slice(0, 10) : null,
    discovery: r.discovery || {},
    dailyEngagement: Array.isArray(r.daily_engagement) ? r.daily_engagement : [],
    dailyFollowers: Array.isArray(r.daily_followers) ? r.daily_followers : [],
    topPosts: Array.isArray(r.top_posts) ? r.top_posts : [],
    demographics: r.demographics || {},
    pageMetrics: r.page_metrics || {},
    summary: r.summary || {},
    uploadedBy: r.uploaded_by || null,
    uploadedAt: r.uploaded_at ? new Date(r.uploaded_at).toISOString() : null,
  };
}

export async function getLinkedInAnalytics() {
  if (!supabaseConfigured()) {
    return {
      byPlatform: {},
      meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' },
    };
  }
  try {
    const rows = await q(
      `select platform_key, file_name,
              to_char(date_start, 'YYYY-MM-DD') as date_start,
              to_char(date_end, 'YYYY-MM-DD') as date_end,
              date_range_label, total_followers,
              to_char(total_followers_date, 'YYYY-MM-DD') as total_followers_date,
              discovery, daily_engagement, daily_followers, top_posts,
              demographics, page_metrics, summary, uploaded_by, uploaded_at
         from public.linkedin_analytics_imports
        order by platform_key asc`
    );
    const byPlatform = {};
    for (const r of rows) {
      byPlatform[r.platform_key] = rowToApi(r);
    }
    const count = Object.keys(byPlatform).length;
    return {
      byPlatform,
      meta: {
        status: count ? 'live' : 'pending',
        source: SRC,
        note: count ? `${count} LinkedIn account(s) imported.` : 'No LinkedIn Analytics imports yet.',
      },
    };
  } catch (err) {
    if (err && err.code === '42P01') {
      return {
        byPlatform: {},
        meta: {
          status: 'pending',
          source: SRC,
          note: 'Table public.linkedin_analytics_imports not created yet — apply migration 20261126130000_create_linkedin_analytics_imports.sql.',
        },
      };
    }
    throw err;
  }
}

export async function saveLinkedInImport(platformKey, files, userEmail) {
  if (!ALLOWED_LINKEDIN_PLATFORMS.includes(platformKey)) {
    const err = new Error('platformKey must be "james_linkedin" or "mag_linkedin".');
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(files) || !files.length) {
    const err = new Error('At least one .xlsx or .xls file is required.');
    err.status = 400;
    throw err;
  }

  const parsedList = [];
  for (const f of files) {
    const b64 = cleanStr(f && f.base64);
    if (!b64) {
      const err = new Error('File payload is empty.');
      err.status = 400;
      throw err;
    }
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 12 * 1024 * 1024) {
      const err = new Error('File exceeds the 12 MB limit.');
      err.status = 400;
      throw err;
    }
    try {
      parsedList.push(parseLinkedInWorkbook(buf, f.fileName));
    } catch (parseErr) {
      parseErr.status = 400;
      throw parseErr;
    }
  }

  if (!supabaseConfigured()) {
    const err = new Error('Supabase is not configured on this server.');
    err.status = 503;
    throw err;
  }

  try {
    // Merge with existing record for this platform_key so uploading followers,
    // visitors, content, and competitors in separate steps preserves prior sheets.
    const existingRows = await q(
      `select platform_key, file_name,
              to_char(date_start, 'YYYY-MM-DD') as date_start,
              to_char(date_end, 'YYYY-MM-DD') as date_end,
              date_range_label, total_followers,
              to_char(total_followers_date, 'YYYY-MM-DD') as total_followers_date,
              discovery, daily_engagement, daily_followers, top_posts,
              demographics, page_metrics, summary, uploaded_by, uploaded_at
         from public.linkedin_analytics_imports
        where platform_key = $1`,
      [platformKey]
    );
    const existing = existingRows.length ? rowToApi(existingRows[0]) : null;
    const merged = mergeLinkedInWorkbooks(existing ? [existing, ...parsedList] : parsedList);

    const rows = await q(
      `insert into public.linkedin_analytics_imports (
         platform_key, file_name, date_start, date_end, date_range_label,
         total_followers, total_followers_date,
         discovery, daily_engagement, daily_followers, top_posts,
         demographics, page_metrics, summary, uploaded_by, uploaded_at, updated_at
       ) values (
         $1, $2, $3, $4, $5,
         $6, $7,
         $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb,
         $12::jsonb, $13::jsonb, $14::jsonb, $15, now(), now()
       )
       on conflict (platform_key) do update set
         file_name            = excluded.file_name,
         date_start           = excluded.date_start,
         date_end             = excluded.date_end,
         date_range_label     = excluded.date_range_label,
         total_followers      = excluded.total_followers,
         total_followers_date = excluded.total_followers_date,
         discovery            = excluded.discovery,
         daily_engagement     = excluded.daily_engagement,
         daily_followers      = excluded.daily_followers,
         top_posts            = excluded.top_posts,
         demographics         = excluded.demographics,
         page_metrics         = excluded.page_metrics,
         summary              = excluded.summary,
         uploaded_by          = excluded.uploaded_by,
         uploaded_at          = now(),
         updated_at           = now()
       returning platform_key, file_name,
                 to_char(date_start, 'YYYY-MM-DD') as date_start,
                 to_char(date_end, 'YYYY-MM-DD') as date_end,
                 date_range_label, total_followers,
                 to_char(total_followers_date, 'YYYY-MM-DD') as total_followers_date,
                 discovery, daily_engagement, daily_followers, top_posts,
                 demographics, page_metrics, summary, uploaded_by, uploaded_at`,
      [
        platformKey,
        merged.fileName,
        merged.dateStart,
        merged.dateEnd,
        merged.dateRangeLabel,
        merged.totalFollowers,
        merged.totalFollowersDate,
        JSON.stringify(merged.discovery),
        JSON.stringify(merged.dailyEngagement),
        JSON.stringify(merged.dailyFollowers),
        JSON.stringify(merged.topPosts),
        JSON.stringify(merged.demographics),
        JSON.stringify(merged.pageMetrics),
        JSON.stringify(merged.summary),
        userEmail || null,
      ]
    );

    await q(
      `insert into public.linkedin_analytics_import_log
         (platform_key, file_name, date_start, date_end, summary, uploaded_by)
       values ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        platformKey,
        parsedList.map((p) => p.fileName).join(', '),
        merged.dateStart,
        merged.dateEnd,
        JSON.stringify(merged.summary),
        userEmail || null,
      ]
    );

    return rowToApi(rows[0]);
  } catch (err) {
    if (err && err.code === '42P01') {
      const mErr = new Error('Database table public.linkedin_analytics_imports does not exist yet. Please run supabase/migrations/20261126130000_create_linkedin_analytics_imports.sql in Supabase first.');
      mErr.status = 503;
      throw mErr;
    }
    throw err;
  }
}
