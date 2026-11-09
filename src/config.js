// All configuration comes from the environment. See .env.example.
//
// Two processes use this:
// - the review site (src/server.js) needs the link secret, ingest token hash and Resend settings;
// - the weekly routine (src/cli.js collect/publish) needs the app URLs and tokens, plus the site URL and ingest token.

export const APPS = ['macros', 'workouts', 'spending', 'checklist', 'planner'];

export function loadConfig(env = process.env) {
  const sources = Object.fromEntries(APPS.map((app) => {
    const key = app.toUpperCase();
    return [app, {
      url: (env[`${key}_API_URL`] || '').replace(/\/$/, '') || null,
      token: env[`${key}_SUMMARY_TOKEN`] || null,
    }];
  }));
  return {
    reviewEmail: env.REVIEW_EMAIL, // email recipient
    timezone: env.REVIEW_TIMEZONE || 'America/New_York',
    dataDir: env.DATA_DIR || './data',
    publicUrl: (env.PUBLIC_URL || 'http://localhost:8790').replace(/\/$/, ''),
    port: Number(env.PORT || 8790),
    linkSecret: env.LINK_SECRET,
    // Hex SHA-256 of the token the routine uses to post reviews. Unset = ingest disabled.
    ingestTokenSha256: (env.INGEST_TOKEN_SHA256 || '').toLowerCase() || null,
    resendApiKey: env.RESEND_API_KEY || null,
    emailFrom: env.REVIEW_EMAIL_FROM || 'Weekly Review <review@weekofus.com>',

    // Routine side.
    sources,
    siteUrl: (env.REVIEW_SITE_URL || env.PUBLIC_URL || '').replace(/\/$/, '') || null,
    ingestToken: env.REVIEW_INGEST_TOKEN || null,
    fetchTimeoutMs: Number(env.SOURCE_TIMEOUT_MS || 20000),
  };
}
