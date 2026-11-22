// All configuration comes from the environment. See .env.example.
//
// Two processes use this:
// - the review site (src/server.js) needs the link secret, ingest token hash and Resend settings;
// - the weekly routine (src/cli.js collect/publish) needs the app URLs and tokens, plus the site URL and ingest token;
// - the owner's Mac (src/cli.js post-notes) needs the site URL and the notes token (NOTES_TOKEN or a token file).

export const APPS = ['macros', 'workouts', 'spending', 'checklist', 'planner', 'journal'];

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
    // Hex SHA-256 of the notes token on the owner's Mac. Unset = notes PUT disabled.
    notesTokenSha256: (env.NOTES_TOKEN_SHA256 || '').toLowerCase() || null,
    resendApiKey: env.RESEND_API_KEY || null,
    // Google sign-in for /summaries. Both unset (or either) = the pages are a 404.
    googleClientId: (env.GOOGLE_CLIENT_ID || '').trim() || null,
    summariesAllowedEmails: (env.SUMMARIES_ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    emailFrom: env.REVIEW_EMAIL_FROM || 'Weekly Review <review@weekofus.com>',
    // Task Sidekick, which turns accepted commitments into reminders (src/tasks.js).
    // Either unset = nothing is sent and no check-offs are read.
    tasksUrl: (env.TASKS_API_URL || '').replace(/\/$/, '') || null,
    tasksToken: env.TASKS_COMMITMENTS_TOKEN || null,

    // Routine side.
    sources,
    siteUrl: (env.REVIEW_SITE_URL || env.PUBLIC_URL || '').replace(/\/$/, '') || null,
    ingestToken: env.REVIEW_INGEST_TOKEN || null,
    notesToken: env.NOTES_TOKEN || null,
    // In the cloud routine, tokens live as network secrets: the agent proxy adds
    // Authorization to requests for each host, so the session never holds them.
    // Then a source or the site counts as configured by its URL alone.
    authViaProxy: env.AUTH_VIA_PROXY === '1',
    fetchTimeoutMs: Number(env.SOURCE_TIMEOUT_MS || 20000),
  };
}
