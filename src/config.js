// All configuration comes from the environment. See .env.example.

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadConfig(env = process.env) {
  return {
    reviewEmail: env.REVIEW_EMAIL, // whose data to review; also the email recipient
    timezone: env.REVIEW_TIMEZONE || 'America/New_York',
    sendDay: Number(env.REVIEW_SEND_DAY ?? 0), // 0 = Sunday
    sendHour: Number(env.REVIEW_SEND_HOUR ?? 18),
    dataDir: env.DATA_DIR || './data',
    publicUrl: (env.PUBLIC_URL || 'http://localhost:8790').replace(/\/$/, ''),
    port: Number(env.PORT || 8790),
    linkSecret: env.LINK_SECRET,
    db: {
      macros: env.MACROS_DATABASE_URL,
      spending: env.SPENDING_DATABASE_URL,
      checklist: env.DAILY_DATABASE_URL,
      planner: env.PLANNER_DATABASE_URL,
      ssl: env.PGSSL === 'true',
    },
    spendingOwnerEmail: env.SPENDING_OWNER_EMAIL || null,
    dynamo: {
      table: env.WORKOUT_TABLE_NAME || 'workout-planner',
      endpoint: env.AWS_ENDPOINT_URL_DYNAMODB || undefined,
      region: env.AWS_REGION || 'us-east-1',
      enabled: env.WORKOUTS_ENABLED !== 'false',
    },
    anthropicModel: env.REVIEW_MODEL || 'claude-opus-5-5',
    narrativeEnabled: Boolean(env.ANTHROPIC_API_KEY) && env.NARRATIVE_ENABLED !== 'false',
    resendApiKey: env.RESEND_API_KEY || null,
    emailFrom: env.REVIEW_EMAIL_FROM || 'Weekly Review <review@weekofus.com>',
  };
}

export { required };
