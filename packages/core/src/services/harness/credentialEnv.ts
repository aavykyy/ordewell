/**
 * The host variables a planner started with the native-shell opt-in must not
 * carry (ADR-0036 N2.2). A sandboxed command on macOS can read the environment
 * of its parent harness process through `sysctl kern.procargs2`, so a value
 * that is still there is in reach whatever the profile denies. The planner's
 * process is started without them instead.
 *
 * Names and shapes are both curated: no list can name every service, and a
 * variable's own name is the only signal there is. The harness's own login is
 * kept, or the planner could not run at all (N3); cloud credentials are not,
 * even where the harness is configured to use them, because the shell must not
 * be able to act on the user's accounts (N2.2).
 */
const HARNESS_LOGIN = new Set([
  // The harness's own API key or token, and the endpoint it talks to.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  // Provider selection and the non-secret locals a selected provider reads.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'GOOGLE_CLOUD_PROJECT',
]);

const CREDENTIAL_NAMES = new Set([
  // Git hosts and package registries.
  'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PAT', 'GITLAB_TOKEN', 'GL_TOKEN', 'GITLAB_PAT', 'BITBUCKET_TOKEN',
  'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'YARN_NPM_AUTH_TOKEN', 'PNPM_TOKEN', 'NPM_CONFIG__AUTH', 'NPM_CONFIG__AUTHTOKEN',
  'DOCKER_AUTH_CONFIG', 'DOCKER_PASSWORD', 'DOCKER_TOKEN',
  // Cloud CLIs and infrastructure tools.
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN',
  'AZURE_CLIENT_SECRET', 'AZURE_STORAGE_KEY', 'AZURE_STORAGE_CONNECTION_STRING', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_ACCESS_TOKEN',
  'ARM_CLIENT_SECRET', 'ARM_ACCESS_KEY', 'ARM_CLIENT_CERTIFICATE_PASSWORD',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_APPLICATION_CREDENTIALS_JSON', 'GOOGLE_OAUTH_ACCESS_TOKEN',
  'GCLOUD_ACCESS_TOKEN', 'CLOUDSDK_AUTH_ACCESS_TOKEN',
  'VAULT_TOKEN', 'VAULT_PASSWORD', 'CONSUL_HTTP_TOKEN', 'NOMAD_TOKEN',
  // Databases and other services whose URL or name carries a password.
  'PGPASSWORD', 'PGPASSFILE', 'MYSQL_PWD', 'DATABASE_URL', 'MONGO_URL', 'MONGODB_URI', 'REDIS_URL', 'AMQP_URL', 'NETRC',
  // Agents whose socket the sandbox denies anyway.
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  // CI, chat and payment tokens.
  'CI_JOB_TOKEN', 'JENKINS_TOKEN', 'CIRCLE_TOKEN', 'TRAVIS_TOKEN', 'CODECOV_TOKEN', 'SONAR_TOKEN',
  'SLACK_TOKEN', 'DISCORD_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TWILIO_AUTH_TOKEN', 'SENDGRID_API_KEY', 'MAILGUN_API_KEY',
  'STRIPE_SECRET_KEY', 'STRIPE_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY',
  'DIGITALOCEAN_ACCESS_TOKEN', 'DO_API_TOKEN', 'LINODE_TOKEN', 'HETZNER_TOKEN', 'FLY_API_TOKEN',
  'VERCEL_TOKEN', 'NETLIFY_AUTH_TOKEN', 'HEROKU_API_KEY', 'FIREBASE_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_KEY',
  // Model providers other than the harness's own.
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'COHERE_API_KEY',
  'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'PERPLEXITY_API_KEY',
  'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'REPLICATE_API_TOKEN', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY',
]);

const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /(?:^|_)(?:TOKEN|SECRET|SECRET_KEY|PASSWORD|PASSWD|PASSPHRASE|API_KEY|APIKEY|ACCESS_KEY|ACCESS_KEY_ID|PRIVATE_KEY|CREDENTIALS?|CONNECTION_STRING|DSN|PAT)$/,
  /(?:^|_)(?:DATABASE|MONGO|MONGODB|REDIS|AMQP|RABBITMQ|POSTGRES|MYSQL|MARIADB)_(?:URL|URI)$/,
  /(?:^|_)WEBHOOK_URL$/,
];

/** Whether a host variable carries a credential the native shell must not inherit (N2.2). */
export function isCredentialVariable(name: string): boolean {
  const upper = name.toUpperCase();
  if (HARNESS_LOGIN.has(upper)) return false;
  return CREDENTIAL_NAMES.has(upper) || CREDENTIAL_SHAPES.some((shape) => shape.test(upper));
}
