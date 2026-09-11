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
};

export function hasSource(name) {
  switch (name) {
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
    default:
      return false;
  }
}
