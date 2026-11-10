-- public.ai_source_patterns — the maintained list of AI-assistant referral sources.
-- ---------------------------------------------------------------------------
-- Single source of truth for which GA4 `sessionSource` values count as an
-- "AI tool" visit. Read at request time by the `ga4-website-traffic-sync` edge
-- function (which classifies GA4 traffic into "Visits from AI tools" on
-- public/website_search.html), replacing the hardcoded AI_SOURCE_RE regex — the
-- regex now only survives as a fallback if this table is empty/unreachable.
--
-- APPEND-ONLY / NEVER REMOVE:
--   • New patterns are added monthly by the `ai-source-patterns-sync` edge
--     function (a curated baseline + OpenAI-discovered new AI tools), via
--     `reload_ai_source_patterns(_rows jsonb)` which uses `on conflict do nothing`
--     — it only ever INSERTs, never updates or deletes existing rows.
--   • A BEFORE DELETE trigger blocks DELETE, so a site, once added, is never
--     removed. To stop matching on a bad/over-broad pattern, a human sets
--     `active = false` (a soft-disable the reader honours); the row stays.
--
-- Matching is plain case-insensitive SUBSTRING containment (src.includes(pattern)),
-- NOT regex — so patterns are literal fragments like 'chatgpt', 'claude.ai',
-- 'gemini.google'. This also means LLM-proposed patterns can never inject regex.

create table if not exists public.ai_source_patterns (
  pattern   text        primary key,                 -- lowercase substring matched against GA4 sessionSource
  label     text,                                    -- human name, e.g. 'ChatGPT'
  vendor    text,                                    -- e.g. 'OpenAI'
  region    text,                                    -- e.g. 'US', 'China', 'EU'
  source    text        not null default 'seed',     -- how it was added: 'seed' (curated) | 'llm' | 'manual'
  active    boolean     not null default true,       -- soft-disable switch (reader filters on this); we never DELETE
  added_at  timestamptz not null default now(),
  notes     text
);

comment on table public.ai_source_patterns is
  'Append-only maintained list of AI-assistant referral sources (GA4 sessionSource substrings). Added monthly by ai-source-patterns-sync (curated seed + OpenAI discovery); read by ga4-website-traffic-sync. Never removed — soft-disable via active=false.';

create index if not exists ai_source_patterns_active_idx
  on public.ai_source_patterns (active);

-- Read-only to the dashboard's direct pg connection; writes via service_role / security definer RPC.
alter table public.ai_source_patterns enable row level security;

-- Guard trigger: forbid DELETE so a site once added can only be soft-disabled, never removed.
create or replace function public.ai_source_patterns_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'public.ai_source_patterns is append-only: DELETE is not permitted (set active = false to stop matching)';
end;
$$;

drop trigger if exists ai_source_patterns_forbid_delete on public.ai_source_patterns;
create trigger ai_source_patterns_forbid_delete
  before delete on public.ai_source_patterns
  for each row execute function public.ai_source_patterns_no_delete();

-- reload_ai_source_patterns(_rows jsonb)
-- Appends any new patterns from a JSONB array built by the ai-source-patterns-sync
-- edge function. INSERT-ONLY: `on conflict (pattern) do nothing` so an existing
-- pattern (including a human-disabled one) is never touched. An empty/null payload
-- is a no-op (returns 0) — a clean month with nothing new is normal, not an error.
-- Returns the number of rows newly inserted.
create or replace function public.reload_ai_source_patterns(_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n int;
begin
  if _rows is null or jsonb_typeof(_rows) <> 'array' or jsonb_array_length(_rows) = 0 then
    return 0;
  end if;

  insert into public.ai_source_patterns (pattern, label, vendor, region, source, notes)
  select
    lower(btrim(r.pattern)),
    nullif(btrim(r.label), ''),
    nullif(btrim(r.vendor), ''),
    nullif(btrim(r.region), ''),
    coalesce(nullif(btrim(r.source), ''), 'seed'),
    nullif(btrim(r.notes), '')
  from jsonb_to_recordset(_rows) as r(
    pattern text,
    label   text,
    vendor  text,
    region  text,
    source  text,
    notes   text
  )
  where r.pattern is not null and btrim(r.pattern) <> ''
  on conflict (pattern) do nothing;

  get diagnostics n = row_count;
  return n;
end;
$$;

-- Seed the curated baseline so the table is fully populated the moment this
-- migration runs (the consumer can read it immediately; the monthly function
-- re-asserts this same baseline idempotently + augments it via OpenAI).
-- Includes every entry from the former AI_SOURCE_RE PLUS the gaps it was missing
-- (notably Chinese AI tools: Qwen, Kimi, Doubao, Ernie, ChatGLM, Spark).
select public.reload_ai_source_patterns('[
  {"pattern": "chatgpt",          "label": "ChatGPT",              "vendor": "OpenAI",        "region": "US",    "source": "seed"},
  {"pattern": "openai",           "label": "OpenAI (chat.openai)", "vendor": "OpenAI",        "region": "US",    "source": "seed"},
  {"pattern": "claude.ai",        "label": "Claude",               "vendor": "Anthropic",     "region": "US",    "source": "seed"},
  {"pattern": "claude.com",       "label": "Claude (claude.com)",  "vendor": "Anthropic",     "region": "US",    "source": "seed"},
  {"pattern": "anthropic",        "label": "Anthropic",            "vendor": "Anthropic",     "region": "US",    "source": "seed"},
  {"pattern": "perplexity",       "label": "Perplexity",           "vendor": "Perplexity",    "region": "US",    "source": "seed"},
  {"pattern": "gemini.google",    "label": "Gemini",               "vendor": "Google",        "region": "US",    "source": "seed"},
  {"pattern": "bard.google",      "label": "Bard (legacy Gemini)", "vendor": "Google",        "region": "US",    "source": "seed"},
  {"pattern": "aistudio.google",  "label": "Google AI Studio",     "vendor": "Google",        "region": "US",    "source": "seed"},
  {"pattern": "copilot",          "label": "Copilot (MS/GitHub)",  "vendor": "Microsoft",     "region": "US",    "source": "seed"},
  {"pattern": "edgeservices",     "label": "Edge Copilot",         "vendor": "Microsoft",     "region": "US",    "source": "seed"},
  {"pattern": "poe.com",          "label": "Poe",                  "vendor": "Quora",         "region": "US",    "source": "seed"},
  {"pattern": "you.com",          "label": "You.com",              "vendor": "You.com",       "region": "US",    "source": "seed"},
  {"pattern": "phind",            "label": "Phind",                "vendor": "Phind",         "region": "US",    "source": "seed"},
  {"pattern": "mistral",          "label": "Mistral / Le Chat",    "vendor": "Mistral AI",    "region": "EU",    "source": "seed"},
  {"pattern": "meta.ai",          "label": "Meta AI",              "vendor": "Meta",          "region": "US",    "source": "seed"},
  {"pattern": "grok",             "label": "Grok",                 "vendor": "xAI",           "region": "US",    "source": "seed"},
  {"pattern": "duck.ai",          "label": "DuckDuckGo AI",        "vendor": "DuckDuckGo",    "region": "US",    "source": "seed"},
  {"pattern": "character.ai",     "label": "Character.AI",         "vendor": "Character.AI",  "region": "US",    "source": "seed"},
  {"pattern": "huggingface.co",   "label": "HuggingChat",          "vendor": "Hugging Face",  "region": "US",    "source": "seed"},
  {"pattern": "deepseek",         "label": "DeepSeek",             "vendor": "DeepSeek",      "region": "China", "source": "seed"},
  {"pattern": "qwen",             "label": "Qwen",                 "vendor": "Alibaba",       "region": "China", "source": "seed"},
  {"pattern": "tongyi",           "label": "Tongyi Qianwen",       "vendor": "Alibaba",       "region": "China", "source": "seed"},
  {"pattern": "kimi",             "label": "Kimi",                 "vendor": "Moonshot AI",   "region": "China", "source": "seed"},
  {"pattern": "doubao",           "label": "Doubao",               "vendor": "ByteDance",     "region": "China", "source": "seed"},
  {"pattern": "yiyan.baidu",      "label": "Ernie Bot (Wenxin)",   "vendor": "Baidu",         "region": "China", "source": "seed"},
  {"pattern": "chatglm",          "label": "ChatGLM",              "vendor": "Zhipu AI",      "region": "China", "source": "seed"},
  {"pattern": "zhipu",            "label": "Zhipu AI",             "vendor": "Zhipu AI",      "region": "China", "source": "seed"},
  {"pattern": "xinghuo",          "label": "Spark (Xinghuo)",      "vendor": "iFlytek",       "region": "China", "source": "seed"}
]'::jsonb);
