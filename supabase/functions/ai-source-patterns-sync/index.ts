// ai-source-patterns-sync — monthly maintenance of the AI-assistant referral list.
//
// Keeps public.ai_source_patterns fresh so the "Visits from AI tools" metric on
// website_search.html stays accurate as new AI tools launch. Two steps per run:
//   1. CURATED BASELINE — re-assert a hand-maintained canonical list (incl. Chinese
//      AIs: Qwen, Kimi, Doubao, Ernie, ChatGLM, Spark) so known tools are always
//      present even if the table was emptied.
//   2. LLM DISCOVERY (best-effort) — ask OpenAI for AI-assistant referral domains
//      not already in the table, sanitize + guardrail the answer, and append the
//      survivors. Skipped silently if OPENAI_API_KEY is unset.
//
// APPEND-ONLY: it only ever INSERTs new patterns (reload_ai_source_patterns uses
// `on conflict do nothing`). It NEVER updates, deletes, re-activates, or removes an
// existing pattern. A human disables a bad pattern with `active = false`; this
// function leaves that untouched.
//
// Invoke: ?dry=1 (preview, no write) · ?sync=1 (write inline) · bare (background 202).
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), OPENAI_API_KEY (optional,
//          enables discovery), OPENAI_MODEL (optional, default gpt-4o-mini), plus
//          optional GMAIL_USER / GMAIL_APP_PASSWORD / ALERT_EMAIL for failure alerts.
// Deploy: supabase functions deploy ai-source-patterns-sync --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = (Deno.env.get("OPENAI_API_KEY") ?? "").trim();
const OPENAI_MODEL = (Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini").trim();

const GMAIL_USER = Deno.env.get("GMAIL_USER") ?? "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
const ALERT_EMAIL = Deno.env.get("ALERT_EMAIL") ?? "julienne@myadventuregroup.com.au";

// Cap how many LLM-proposed patterns we accept in one run (defence against a runaway reply).
const MAX_LLM_ADDS = 30;

type Candidate = {
  pattern: string;
  label?: string;
  vendor?: string;
  region?: string;
  source: string;
  notes?: string;
};

// ---- Curated canonical baseline (mirrors the seed migration) --------------
// Literal lowercase SUBSTRINGS matched against GA4 sessionSource. Keep product
// hostnames specific (e.g. "gemini.google", never "google") to avoid counting
// general search/social traffic. Add a new tool here to guarantee it monthly.
const CANONICAL: Candidate[] = [
  { pattern: "chatgpt",         label: "ChatGPT",              vendor: "OpenAI",       region: "US",    source: "seed" },
  { pattern: "openai",          label: "OpenAI (chat.openai)", vendor: "OpenAI",       region: "US",    source: "seed" },
  { pattern: "claude.ai",       label: "Claude",               vendor: "Anthropic",    region: "US",    source: "seed" },
  { pattern: "claude.com",      label: "Claude (claude.com)",  vendor: "Anthropic",    region: "US",    source: "seed" },
  { pattern: "anthropic",       label: "Anthropic",            vendor: "Anthropic",    region: "US",    source: "seed" },
  { pattern: "perplexity",      label: "Perplexity",           vendor: "Perplexity",   region: "US",    source: "seed" },
  { pattern: "gemini.google",   label: "Gemini",               vendor: "Google",       region: "US",    source: "seed" },
  { pattern: "bard.google",     label: "Bard (legacy Gemini)", vendor: "Google",       region: "US",    source: "seed" },
  { pattern: "aistudio.google", label: "Google AI Studio",     vendor: "Google",       region: "US",    source: "seed" },
  { pattern: "copilot",         label: "Copilot (MS/GitHub)",  vendor: "Microsoft",    region: "US",    source: "seed" },
  { pattern: "edgeservices",    label: "Edge Copilot",         vendor: "Microsoft",    region: "US",    source: "seed" },
  { pattern: "poe.com",         label: "Poe",                  vendor: "Quora",        region: "US",    source: "seed" },
  { pattern: "you.com",         label: "You.com",              vendor: "You.com",      region: "US",    source: "seed" },
  { pattern: "phind",           label: "Phind",                vendor: "Phind",        region: "US",    source: "seed" },
  { pattern: "mistral",         label: "Mistral / Le Chat",    vendor: "Mistral AI",   region: "EU",    source: "seed" },
  { pattern: "meta.ai",         label: "Meta AI",              vendor: "Meta",         region: "US",    source: "seed" },
  { pattern: "grok",            label: "Grok",                 vendor: "xAI",          region: "US",    source: "seed" },
  { pattern: "duck.ai",         label: "DuckDuckGo AI",        vendor: "DuckDuckGo",   region: "US",    source: "seed" },
  { pattern: "character.ai",    label: "Character.AI",         vendor: "Character.AI", region: "US",    source: "seed" },
  { pattern: "huggingface.co",  label: "HuggingChat",          vendor: "Hugging Face", region: "US",    source: "seed" },
  { pattern: "deepseek",        label: "DeepSeek",             vendor: "DeepSeek",     region: "China", source: "seed" },
  { pattern: "qwen",            label: "Qwen",                 vendor: "Alibaba",      region: "China", source: "seed" },
  { pattern: "tongyi",          label: "Tongyi Qianwen",       vendor: "Alibaba",      region: "China", source: "seed" },
  { pattern: "kimi",            label: "Kimi",                 vendor: "Moonshot AI",  region: "China", source: "seed" },
  { pattern: "doubao",          label: "Doubao",               vendor: "ByteDance",    region: "China", source: "seed" },
  { pattern: "yiyan.baidu",     label: "Ernie Bot (Wenxin)",   vendor: "Baidu",        region: "China", source: "seed" },
  { pattern: "chatglm",         label: "ChatGLM",              vendor: "Zhipu AI",     region: "China", source: "seed" },
  { pattern: "zhipu",           label: "Zhipu AI",             vendor: "Zhipu AI",     region: "China", source: "seed" },
  { pattern: "xinghuo",         label: "Spark (Xinghuo)",      vendor: "iFlytek",      region: "China", source: "seed" },
];

// Tokens that must NEVER become a pattern: general search engines, social networks,
// and over-broad words. Substring-matching any of these would wrongly flag large
// swathes of ordinary traffic as "AI". An LLM proposal equal to, or containing, one
// of these is rejected.
const DENY = new Set([
  "google", "bing", "yahoo", "baidu", "yandex", "duckduckgo", "ecosia", "naver",
  "facebook", "instagram", "twitter", "x.com", "t.co", "reddit", "linkedin",
  "youtube", "tiktok", "pinterest", "whatsapp", "telegram",
  "ai", "chat", "bot", "gpt", "llm", "search", "assistant", "chatbot", "www",
]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });

// Normalise a raw candidate pattern to a safe lowercase substring, or null to reject.
function sanitizePattern(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim().toLowerCase();
  if (!p) return null;
  p = p.replace(/^https?:\/\//, "").replace(/^www\./, ""); // strip scheme + www
  p = p.split(/[\/?#]/)[0]; // drop any path/query/fragment
  p = p.trim();
  if (p.length < 4 || p.length > 60) return null;          // too short over-matches; too long is junk
  if (!/^[a-z0-9][a-z0-9.\-]*$/.test(p)) return null;      // hostname-ish chars only (no regex metachars)
  if (!/[a-z]/.test(p)) return null;                        // must contain a letter
  if (DENY.has(p)) return null;                             // exact-match a banned general source
  for (const bad of DENY) {                                 // or a bare banned token as a dotted label
    if (p === bad || p.startsWith(bad + ".") || p.endsWith("." + bad) || p.includes("." + bad + ".")) {
      return null;
    }
  }
  return p;
}

// ---- OpenAI discovery (best-effort) ---------------------------------------
async function discoverViaLLM(existing: Set<string>): Promise<{ accepted: Candidate[]; proposed: number; error: string | null }> {
  if (!OPENAI_API_KEY) return { accepted: [], proposed: 0, error: null };

  const existingList = [...existing].sort().join(", ");
  const sys =
    "You maintain a list of AI-assistant / chatbot / answer-engine websites whose " +
    "hostname can appear as a referral `sessionSource` in Google Analytics. Return ONLY " +
    "specific AI product hostnames (e.g. \"gemini.google.com\", \"kimi.com\", \"doubao.com\"). " +
    "NEVER return a general search engine or social network (google, bing, baidu, yandex, " +
    "duckduckgo, facebook, x.com, youtube, etc.) or a bare word like \"ai\"/\"chat\". " +
    "Include global, Chinese, and other regional AI tools. Respond as JSON.";
  const user =
    "Return JSON of the form {\"sources\":[{\"pattern\":\"host\",\"label\":\"Name\",\"vendor\":\"Company\",\"region\":\"US|China|EU|...\"}]}. " +
    "`pattern` is the lowercase hostname fragment to substring-match (keep it specific, e.g. " +
    "\"gemini.google\" not \"google\"). Only include AI tools NOT already in this list: " +
    (existingList || "(none)") + ". If there are no new ones, return {\"sources\":[]}.";

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
    });
    const j = await resp.json();
    if (!resp.ok) throw new Error(`OpenAI error (${resp.status}): ${JSON.stringify(j)}`);
    const content = j.choices?.[0]?.message?.content ?? "{}";
    let parsed: any;
    try { parsed = JSON.parse(content); } catch { throw new Error("OpenAI returned non-JSON content"); }
    const list: any[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.sources) ? parsed.sources : []);

    const accepted: Candidate[] = [];
    const seen = new Set<string>(existing);
    for (const item of list) {
      const raw = typeof item === "string" ? item : item?.pattern;
      const clean = sanitizePattern(raw);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      accepted.push({
        pattern: clean,
        label: typeof item?.label === "string" ? item.label.slice(0, 80) : undefined,
        vendor: typeof item?.vendor === "string" ? item.vendor.slice(0, 80) : undefined,
        region: typeof item?.region === "string" ? item.region.slice(0, 40) : undefined,
        source: "llm",
        notes: "proposed by OpenAI " + OPENAI_MODEL,
      });
      if (accepted.length >= MAX_LLM_ADDS) break;
    }
    return { accepted, proposed: list.length, error: null };
  } catch (err) {
    // Discovery is best-effort: never fail the whole run because OpenAI hiccuped.
    return { accepted: [], proposed: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

type Summary = {
  fn: string;
  existing_count: number;
  canonical_missing: number;
  llm_proposed: number;
  llm_accepted: number;
  added: Array<{ pattern: string; source: string }>;
  added_count: number;
  llm_error: string | null;
  openai_enabled: boolean;
  dry: boolean;
  duration_ms: number;
  ok: boolean;
  error: string | null;
};

async function sendFailureEmail(summary: Summary, detail: string): Promise<void> {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error("[ai-source-patterns-sync] alert email NOT sent — GMAIL_USER/GMAIL_APP_PASSWORD not set");
    return;
  }
  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD },
    },
  });
  try {
    await client.send({
      from: GMAIL_USER,
      to: ALERT_EMAIL,
      subject: "⚠️ ai-source-patterns-sync FAILED",
      content: "auto",
      html: `<p>The <b>ai-source-patterns-sync</b> edge function failed. The
        <code>ai_source_patterns</code> table was <b>NOT</b> modified.</p>
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
  const summary: Summary = {
    fn: "ai-source-patterns-sync",
    existing_count: 0,
    canonical_missing: 0,
    llm_proposed: 0,
    llm_accepted: 0,
    added: [],
    added_count: 0,
    llm_error: null,
    openai_enabled: !!OPENAI_API_KEY,
    dry,
    duration_ms: 0,
    ok: false,
    error: null,
  };

  try {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // 1. Read what's already there (active + inactive — we never re-add either).
    const { data: rows, error: readErr } = await db.from("ai_source_patterns").select("pattern");
    if (readErr) throw new Error(`read ai_source_patterns failed: ${readErr.message}`);
    const existing = new Set<string>((rows ?? []).map((r: any) => String(r.pattern ?? "").trim().toLowerCase()).filter(Boolean));
    summary.existing_count = existing.size;

    // 2. Curated baseline additions (idempotent self-heal).
    const canonicalAdds = CANONICAL.filter((c) => !existing.has(c.pattern));
    summary.canonical_missing = canonicalAdds.length;
    for (const c of canonicalAdds) existing.add(c.pattern); // so LLM step won't re-propose them

    // 3. LLM discovery (best-effort).
    const llm = await discoverViaLLM(existing);
    summary.llm_proposed = llm.proposed;
    summary.llm_accepted = llm.accepted.length;
    summary.llm_error = llm.error;

    const additions: Candidate[] = [...canonicalAdds, ...llm.accepted];
    summary.added = additions.map((a) => ({ pattern: a.pattern, source: a.source }));

    if (dry) {
      summary.added_count = additions.length;
      summary.ok = true;
      summary.duration_ms = Date.now() - started;
      console.log("[ai-source-patterns-sync] DRY:", JSON.stringify(summary));
      return summary;
    }

    if (additions.length > 0) {
      const { data, error } = await db.rpc("reload_ai_source_patterns", { _rows: additions });
      if (error) throw new Error(`reload_ai_source_patterns failed: ${error.message}`);
      summary.added_count = typeof data === "number" ? data : additions.length;
    } else {
      summary.added_count = 0;
    }

    summary.ok = true;
    summary.duration_ms = Date.now() - started;
    console.log("[ai-source-patterns-sync] done:", JSON.stringify(summary));
    return summary;
  } catch (err) {
    summary.ok = false;
    summary.error = err instanceof Error ? err.message : String(err);
    summary.duration_ms = Date.now() - started;
    console.error("[ai-source-patterns-sync] FAILED:", summary.error);
    if (!dry) {
      try {
        await sendFailureEmail(summary, summary.error);
      } catch (mailErr) {
        console.error("[ai-source-patterns-sync] failed to send alert email:", mailErr);
      }
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
    return json(
      { message: "ai-source-patterns-sync started in background", timestamp: new Date().toISOString() },
      202,
    );
  }
  const res = await run(false);
  return json(res, res.ok ? 200 : 500);
});
