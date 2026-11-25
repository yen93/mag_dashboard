// Central config: reads every data-source credential from the environment.
// On Cloud Run these come from Secret Manager / --set-env-vars. Locally they
// come from the shell or a .env you export before `npm run dev`.
//
// Each source is optional. `hasSource(name)` lets the metric layer decide
// whether to run a live query or return a "pending" (needs-setup) metric, so a
// missing credential degrades one set of tiles rather than breaking a page.

const env = process.env;

export const config = {
  supabase: {
    // Full Postgres connection string, e.g.
    // postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres
    dbUrl: env.SUPABASE_DB_URL || '',
    accessToken: env.SUPABASE_ACCESS_TOKEN || '',
    projectId: env.SUPABASE_PROJECT_ID || 'aivitcomiywiysrfwqxt',
  },
  activecampaign: {
    apiUrl: env.AC_API_URL || '',
    apiKey: env.AC_API_KEY || '',
  },
  xero: {
    clientId: env.XERO_CLIENT_ID || '',
    clientSecret: env.XERO_CLIENT_SECRET || '',
    refreshToken: env.XERO_REFRESH_TOKEN || '',
    tenantId: env.XERO_TENANT_ID || '',
  },
  calendly: {
    token: env.CALENDLY_TOKEN || '',
  },
  monday: {
    token: env.MONDAY_TOKEN || '',
  },
  googleSheet: {
    // Service-account JSON (stringified) + the Buyer Analysis sheet id
    serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    buyerAnalysisSheetId: env.BUYER_ANALYSIS_SHEET_ID || '1jaRNT-YCJsBx7cD05Q7bk3-p8vjhWVVxWxdpCMT7YnU',
  },
  email: {
    // Gmail (Google Workspace) account that sends the login-code emails, via
    // SMTP with an app password. When unset, the mailer logs codes to the
    // console instead (dev fallback) — see server/lib/mailer.js.
    gmailUser: env.GMAIL_USER || 'julienne@myadventuregroup.com.au',
    gmailAppPassword: env.GMAIL_APP_PASSWORD || '',
  },
  ga4Agent: {
    // The "GA4 On-Demand Report" Claude routine's one-time fire endpoint + token.
    // The dashboard POSTs here (server-side only) to trigger a GA4 pull; the
    // routine writes its answer back to public.ga4_agent_requests. The token is a
    // secret — set it via Secret Manager / --set-env-vars, never in the client.
    fireUrl: env.GA4_ROUTINE_FIRE_URL || '',
    fireToken: env.GA4_ROUTINE_FIRE_TOKEN || '',
  },
  openai: {
    // OpenAI API key for the ROAS tab's read-only chat assistant
    // (server/roasAssistant.js). The key stays server-side — never sent to the
    // browser. NB: this is the Cloud Run service's own env var (Secret Manager +
    // --update-secrets); a Supabase EDGE secret of the same name is NOT visible
    // here. Model is overridable; defaults to a fast, cheap model.
    apiKey: env.OPENAI_API_KEY || '',
    model: env.OPENAI_MODEL || 'gpt-4o-mini',
  },
  gemini: {
    // Google Gemini API key for the Education Sector Outreach tab's AI insights
    // panel (server/educationInsight.js). Server-side only — never sent to the
    // browser. On Cloud Run, mount the Secret Manager secret
    // `gemini-ai-api-key-131126` as the env var GEMINI_API_KEY
    // (--update-secrets GEMINI_API_KEY=gemini-ai-api-key-131126:latest).
    apiKey: env.GEMINI_API_KEY || '',
    model: env.GEMINI_MODEL || 'gemini-3.8-flash',
  },
  n8n: {
    apiUrl: env.N8N_API_URL || 'https://n8n-659687081407.australia-southeast1.run.app',
    apiKey: env.N8N_API_KEY || '',
    supabaseProjectId: env.N8N_SUPABASE_PROJECT_ID || 'uwsncuowtzydylfabikj',
  },
  meta: {
    // Meta Graph API — the Social Platforms tab's LIVE Facebook Page + Instagram Business
    // figures (server/metrics/meta-fb-insights.js) are fetched at request time with a
    // non-expiring Page access token (a Page token derived from a long-lived user token,
    // carrying instagram_basic / instagram_manage_insights; stays valid while the admin's
    // login does). The linked Instagram account is discovered from the Page at runtime —
    // no IG id needed here. Server-side only — set META_PAGE_TOKEN via Secret Manager +
    // --update-secrets, never in the client. NB Facebook page reach/impressions are
    // deprecated by Meta (views only); Instagram reach IS available.
    pageToken: env.META_PAGE_TOKEN || '',
    pageId: env.META_PAGE_ID || '1421118044806726',
  },
};

export function hasSource(name) {
  switch (name) {
    case 'n8n':
      return Boolean(config.n8n.apiKey);
    case 'supabase':
      return Boolean(config.supabase.dbUrl);
    case 'activecampaign':
      return Boolean(config.activecampaign.apiUrl && config.activecampaign.apiKey);
    case 'xero':
      return Boolean(config.xero.refreshToken && config.xero.clientId && config.xero.tenantId);
    case 'calendly':
      return Boolean(config.calendly.token);
    case 'monday':
      return Boolean(config.monday.token);
    case 'googleSheet':
      return Boolean(config.googleSheet.serviceAccountJson);
    case 'email':
      return Boolean(config.email.gmailUser && config.email.gmailAppPassword);
    case 'ga4Agent':
      return Boolean(config.ga4Agent.fireUrl && config.ga4Agent.fireToken);
    case 'openai':
      return Boolean(config.openai.apiKey);
    case 'gemini':
      return Boolean(config.gemini.apiKey);
    case 'meta':
      return Boolean(config.meta.pageToken);
    default:
      return false;
  }
}
