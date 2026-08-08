// Single source of runtime config. Values come from .env (gitignored, never pushed);
// every default lives here and nowhere else. See .env.example for the full list.
const env = process.env;

const port = Number(env.PORT || 4899);
const baseUrl = env.BASE_URL || `http://localhost:${port}`;

export const config = {
  port,
  baseUrl,
  // BASE_URL is what LINKS point at (tunnel when sharing); internal API calls stay local
  apiUrl: env.MC_API || `http://localhost:${port}/api`,
  mongoUri: env.MONGO_URI || 'mongodb://localhost:27017',
  dbName: env.DB_NAME || 'mission_control',
  filesDir: env.FILES_DIR || new URL('../../../data/files/', import.meta.url).pathname,
  slackBotToken: env.SLACK_BOT_TOKEN || '',
  slackAppToken: env.SLACK_APP_TOKEN || '',
  slackApiBase: env.SLACK_API_BASE || 'https://slack.com/api',
  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  gabbarModel: env.GABBAR_MODEL || 'claude-opus-5',
  gabbarOwnerId: env.GABBAR_OWNER_ID || '',
  bindHost: env.BIND_HOST || '127.0.0.1', // loopback only; a tunnel fronts anything public
  proxyPort: Number(env.PROXY_PORT || 4800),
  proxyAdminToken: env.PROXY_ADMIN_TOKEN || '',
  ngrokDomain: env.NGROK_DOMAIN || '',
  sseKeepaliveMs: 25_000,
  eventsBoardLimit: 50,
  capIdLen: 21,
  serverIdleTimeout: 120,
};
