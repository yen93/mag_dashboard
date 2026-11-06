// apify-platforms-sync — weekly snapshot of each social platform's PUBLIC stats.
//
// Scrapes followers / recent posts / per-post engagement for MAG's social accounts
// via Apify, then UPSERTS one row per platform for today's snapshot into
// public.social_platform_stats (via public.reload_social_platform_stats). The rpc is
// UPSERT-ONLY on (platform_key, snapshot_date) — it never deletes/truncates, so a
// platform that fails this week simply keeps its last-synced snapshot.
//
// Each platform can have MULTIPLE sources (actors) whose outputs are MERGED — e.g.
// LinkedIn uses a followers actor (company/profile details) + a posts actor
// (per-post engagement). All sources across all platforms run in PARALLEL and
// degrade independently: a broken actor is skipped (logged), the rest still write.
// Only if NO platform yields followers or engagement is the run a failure.
//
// SCOPE: Apify reads PUBLIC data only — followers, post counts, per-post
// likes/comments/reactions. Impressions / reach are PRIVATE analytics and are NOT
// scraped. "Change" (follower delta vs the prior weekly snapshot) is derived at query time.
//
// Invoke: ?dry=1 (preview, no write) · ?sync=1 (write inline) · bare (background 202).
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APIFY_API_TOKEN (or APIFY_TOKEN).
// Deploy --no-verify-jwt (cron POST has no auth header).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APIFY_TOKEN = Deno.env.get("APIFY_API_TOKEN") ?? Deno.env.get("APIFY_TOKEN") ?? "";

const GMAIL_USER = Deno.env.get("GMAIL_USER") ?? "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
const ALERT_EMAIL = Deno.env.get("ALERT_EMAIL") ?? "julienne@myadventuregroup.com.au";

const APIFY_RUN_TIMEOUT_S = parseInt(Deno.env.get("APIFY_RUN_TIMEOUT_S") ?? "95", 10);
const MAX_POSTS = parseInt(Deno.env.get("MAX_POSTS") ?? "24", 10);

const MAG_LINKEDIN_URL   = Deno.env.get("MAG_LINKEDIN_URL")   ?? "https://www.linkedin.com/company/myadventure-group/";
const MAG_FACEBOOK_URL   = Deno.env.get("MAG_FACEBOOK_URL")   ?? "https://www.facebook.com/MyAdventureGroup/";
const MAG_INSTAGRAM_URL  = Deno.env.get("MAG_INSTAGRAM_URL")  ?? "https://www.instagram.com/myadventuregroup/";
const JAMES_LINKEDIN_URL = Deno.env.get("JAMES_LINKEDIN_URL") ?? "https://www.linkedin.com/in/james-castrission/";

const ACTOR_INSTAGRAM       = Deno.env.get("APIFY_ACTOR_INSTAGRAM")       ?? "apify/instagram-profile-scraper";
const ACTOR_FACEBOOK        = Deno.env.get("APIFY_ACTOR_FACEBOOK")        ?? "apify/facebook-pages-scraper";
const ACTOR_FACEBOOK_POSTS  = Deno.env.get("APIFY_ACTOR_FACEBOOK_POSTS")  ?? "apify/facebook-posts-scraper";
const ACTOR_LI_COMPANY      = Deno.env.get("APIFY_ACTOR_LI_COMPANY")      ?? "harvestapi/linkedin-company";
const ACTOR_LI_COMPANY_POSTS= Deno.env.get("APIFY_ACTOR_LI_COMPANY_POSTS")?? "harvestapi/linkedin-company-posts";
const ACTOR_LI_PROFILE      = Deno.env.get("APIFY_ACTOR_LI_PROFILE")      ?? "harvestapi/linkedin-profile-scraper";
const ACTOR_LI_PROFILE_POSTS= Deno.env.get("APIFY_ACTOR_LI_PROFILE_POSTS")?? "harvestapi/linkedin-profile-posts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });

// ---- Apify REST ------------------------------------------------------------
async function apifyScrape(actorId: string, input: unknown, tries = 0): Promise<any[]> {
  const path = actorId.replace("/", "~");
  const url =
    `https://api.apify.com/v2/acts/${path}/run-sync-get-dataset-items` +
    `?token=${APIFY_TOKEN}&timeout=${APIFY_RUN_TIMEOUT_S}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (APIFY_RUN_TIMEOUT_S + 10) * 1000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      if ((r.status === 429 || r.status >= 500) && tries < 2) {
        await sleep(2000);
        return apifyScrape(actorId, input, tries + 1);
      }
      throw new Error(`Apify ${actorId} ${r.status}: ${(await r.text()).slice(0, 300)}`);
    }
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timer);
  }
}

// ---- parsing helpers -------------------------------------------------------
function num(obj: any, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = obj?.[k];
    const n = typeof v === "string" ? Number(v.replace(/[, ]/g, "")) : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
// Engagement for ONE post. Handles both shapes: a nested `engagement` object
// (harvestapi LinkedIn: {likes, comments, shares, reactions:[…]}) and flat top-level
// fields (Instagram: likesCount / commentsCount). `reactions` as an array is ignored
// (num() returns null for it); the numeric likes/comments/shares are what count.
function perPostEng(p: any): number {
  const e = (p && typeof p.engagement === "object" && p.engagement) ? p.engagement : p;
  return (num(e, "likes", "likesCount", "reactionsCount", "numLikes", "likeCount") ?? 0) +
         (num(e, "comments", "commentsCount", "numComments", "commentCount") ?? 0) +
         (num(e, "shares", "sharesCount", "repostsCount", "reposts") ?? 0);
}
function sumEngagement(posts: any[]): { posts: number; total: number } | null {
  if (!Array.isArray(posts) || posts.length === 0) return null;
  let total = 0;
  for (const p of posts) total += perPostEng(p);
  return { posts: posts.length, total };
}

type Parsed = { followers: number | null; posts: number | null; totalEngagement: number | null };
const EMPTY: Parsed = { followers: null, posts: null, totalEngagement: null };

type Source = { actorId: string; buildInput: (url: string) => unknown; parse: (items: any[]) => Parsed };
type PlatformCfg = {
  platform_key: string;
  platform_name: string;
  network: string;
  url: string;
  sources: Source[];   // outputs merged (followers / posts / engagement from whichever provides them)
};

// Posts-actor parse (items = an array of post objects) → posts count + summed engagement.
const parsePosts = (items: any[]): Parsed => {
  const eng = sumEngagement(items);
  return { followers: null, posts: eng ? eng.posts : null, totalEngagement: eng ? eng.total : null };
};
const postsInput = (url: string) => ({ targetUrls: [url], maxPosts: MAX_POSTS });

const PLATFORMS: PlatformCfg[] = [
  {
    platform_key: "mag_instagram",
    platform_name: "MyAdventure Group Instagram",
    network: "instagram",
    url: MAG_INSTAGRAM_URL,
    // One actor gives followers AND recent posts (with top-level likesCount/commentsCount).
    sources: [{
      actorId: ACTOR_INSTAGRAM,
      buildInput: (url) => ({ directUrls: [url], usernames: [handleFromUrl(url)], resultsLimit: MAX_POSTS }),
      parse: (items) => {
        const it = items[0] ?? {};
        const eng = sumEngagement(it.latestPosts ?? it.posts ?? []);
        return {
          followers: num(it, "followersCount", "followers"),
          posts: eng ? eng.posts : num(it, "postsCount", "posts"),
          totalEngagement: eng ? eng.total : null,
        };
      },
    }],
  },
  {
    platform_key: "mag_facebook",
    platform_name: "MyAdventure Group Facebook",
    network: "facebook",
    url: MAG_FACEBOOK_URL,
    // Followers from the pages scraper + engagement from the posts scraper, merged.
    // NB the FB posts actor returns top-level `likes`/`shares` (no comments field),
    // so FB engagement = likes + shares; perPostEng() reads those top-level fields.
    sources: [
      {
        actorId: ACTOR_FACEBOOK,
        buildInput: (url) => ({ startUrls: [{ url }] }),
        parse: (items) => {
          const it = items[0] ?? {};
          return { ...EMPTY, followers: num(it, "followers", "followersCount", "likes", "likesCount") };
        },
      },
      {
        actorId: ACTOR_FACEBOOK_POSTS,
        buildInput: (url) => ({ startUrls: [{ url }], resultsLimit: MAX_POSTS }),
        parse: parsePosts,
      },
    ],
  },
  {
    platform_key: "mag_linkedin",
    platform_name: "MyAdventure Group LinkedIn page",
    network: "linkedin",
    url: MAG_LINKEDIN_URL,
    // Followers from company DETAILS + engagement from company POSTS, merged.
    sources: [
      {
        actorId: ACTOR_LI_COMPANY,
        buildInput: (url) => ({ companies: [url] }),
        parse: (items) => ({ ...EMPTY, followers: num(items[0] ?? {}, "followerCount", "followers", "followersCount") }),
      },
      { actorId: ACTOR_LI_COMPANY_POSTS, buildInput: postsInput, parse: parsePosts },
    ],
  },
  {
    platform_key: "james_linkedin",
    platform_name: "James's personal LinkedIn",
    network: "linkedin",
    url: JAMES_LINKEDIN_URL,
    // Followers from profile DETAILS + engagement from profile POSTS, merged.
    sources: [
      {
        actorId: ACTOR_LI_PROFILE,
        buildInput: (url) => ({ queries: [url] }),
        parse: (items) => ({ ...EMPTY, followers: num(items[0] ?? {}, "followerCount", "followersCount", "followers") }),
      },
      { actorId: ACTOR_LI_PROFILE_POSTS, buildInput: postsInput, parse: parsePosts },
    ],
  },
];

function handleFromUrl(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  } catch {
    return "";
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type Row = {
  platform_key: string;
  platform_name: string;
  network: string;
  profile_url: string;
  snapshot_date: string;
  followers: number | null;
  posts: number | null;
  total_engagement: number | null;
  avg_engagement_per_post: number | null;
  engagement_rate: number | null;
  raw: unknown;
};

type Summary = {
  fn: string;
  snapshot_date: string;
  attempted: number;
  scraped: number;
  reloaded_rows: number;
  per_platform: Record<string, { ok: boolean; followers: number | null; posts: number | null; totalEngagement?: number | null; errors?: string[] }>;
  dry: boolean;
  duration_ms: number;
  ok: boolean;
  error: string | null;
};

async function sendFailureEmail(summary: Summary, detail: string): Promise<void> {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error("[apify-platforms-sync] alert email NOT sent — GMAIL_USER/GMAIL_APP_PASSWORD not set");
    return;
  }
  const client = new SMTPClient({
    connection: { hostname: "smtp.gmail.com", port: 465, tls: true,
      auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD } },
  });
  try {
    await client.send({
      from: GMAIL_USER,
      to: ALERT_EMAIL,
      subject: "⚠️ apify-platforms-sync FAILED",
      content: "auto",
      html: `<p>The <b>apify-platforms-sync</b> edge function failed. The
        <code>social_platform_stats</code> table was <b>NOT</b> modified.</p>
        <p><b>Error:</b></p><pre>${detail.replace(/[<>&]/g, (c) =>
          ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string))}</pre>
        <p><b>Summary:</b></p><pre>${JSON.stringify(summary, null, 2)}</pre>
        <p>Ran at ${new Date().toISOString()}</p>`,
    });
  } finally {
    await client.close();
  }
}

async function run(dry: boolean): Promise<Summary> {
  const started = Date.now();
  const snapshot = new Date().toISOString().slice(0, 10);
  const summary: Summary = {
    fn: "apify-platforms-sync",
    snapshot_date: snapshot,
    attempted: 0,
    scraped: 0,
    reloaded_rows: 0,
    per_platform: {},
    dry,
    duration_ms: 0,
    ok: false,
    error: null,
  };

  try {
    if (!APIFY_TOKEN) throw new Error("Missing APIFY_API_TOKEN");
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");

    const active = PLATFORMS.filter((p) => p.url);
    summary.attempted = active.length;
    if (active.length === 0) throw new Error("No profile URLs configured — nothing to scrape");

    // Every source of every platform runs in parallel; merge per platform.
    const perPlatform = await Promise.all(active.map(async (p) => {
      const settled = await Promise.allSettled(p.sources.map(async (s) => {
        const items = await apifyScrape(s.actorId, s.buildInput(p.url));
        return { actorId: s.actorId, items, partial: s.parse(items) };
      }));
      return { p, settled };
    }));

    const rows: Row[] = [];
    for (const { p, settled } of perPlatform) {
      const merged: Parsed = { ...EMPTY };
      const raw: Record<string, unknown> = {};
      const errors: string[] = [];
      for (const res of settled) {
        if (res.status === "rejected") { errors.push(String(res.reason).slice(0, 200)); continue; }
        const { actorId, items, partial } = res.value;
        if (merged.followers == null && partial.followers != null) merged.followers = partial.followers;
        if (merged.posts == null && partial.posts != null) merged.posts = partial.posts;
        if (merged.totalEngagement == null && partial.totalEngagement != null) merged.totalEngagement = partial.totalEngagement;
        raw[actorId] = items[0] ?? null;
      }

      if (merged.followers == null && merged.totalEngagement == null) {
        summary.per_platform[p.platform_key] = { ok: false, followers: null, posts: merged.posts, errors: errors.length ? errors : ["actor returned no parseable followers/engagement"] };
        console.error(`[apify-platforms-sync] ${p.platform_key}: nothing parseable`, errors);
        continue;
      }

      const avg = merged.totalEngagement != null && merged.posts
        ? round2(merged.totalEngagement / merged.posts)
        : null;
      const rate = avg != null && merged.followers
        ? round2((avg / merged.followers) * 100)
        : null;
      summary.scraped += 1;
      summary.per_platform[p.platform_key] = {
        ok: true, followers: merged.followers, posts: merged.posts, totalEngagement: merged.totalEngagement,
        errors: errors.length ? errors : undefined,
      };
      rows.push({
        platform_key: p.platform_key,
        platform_name: p.platform_name,
        network: p.network,
        profile_url: p.url,
        snapshot_date: snapshot,
        followers: merged.followers,
        posts: merged.posts,
        total_engagement: merged.totalEngagement,
        avg_engagement_per_post: avg,
        engagement_rate: rate,
        raw,
      });
    }

    if (rows.length === 0) throw new Error("All platform scrapes failed — table left unchanged");

    if (dry) {
      summary.ok = true;
      summary.duration_ms = Date.now() - started;
      console.log("[apify-platforms-sync] DRY:", JSON.stringify(summary));
      return summary;
    }

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data, error } = await db.rpc("reload_social_platform_stats", { _rows: rows });
    if (error) throw new Error(`reload_social_platform_stats failed: ${error.message}`);
    summary.reloaded_rows = typeof data === "number" ? data : rows.length;

    summary.ok = true;
    summary.duration_ms = Date.now() - started;
    console.log("[apify-platforms-sync] done:", JSON.stringify(summary));
    return summary;
  } catch (err) {
    summary.ok = false;
    summary.error = err instanceof Error ? err.message : String(err);
    summary.duration_ms = Date.now() - started;
    console.error("[apify-platforms-sync] FAILED:", summary.error);
    if (!dry) {
      try { await sendFailureEmail(summary, summary.error); }
      catch (mailErr) { console.error("[apify-platforms-sync] failed to send alert email:", mailErr); }
    }
    return summary;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const sync = url.searchParams.get("sync") === "1";
  if (dry || sync) {
    const res = await run(dry);
    return json(res, res.ok ? 200 : 500);
  }
  if (EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(run(false));
    return json({ message: "apify-platforms-sync started in background", timestamp: new Date().toISOString() }, 202);
  }
  const res = await run(false);
  return json(res, res.ok ? 200 : 500);
});
