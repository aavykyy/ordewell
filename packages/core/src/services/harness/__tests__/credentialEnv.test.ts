import { describe, expect, it } from 'vitest';
import { isCredentialVariable } from '../credentialEnv';

describe('isCredentialVariable (ADR-0036 N2.2)', () => {
  it.each([
    'GITHUB_TOKEN', 'GH_TOKEN', 'GITLAB_PAT', 'BITBUCKET_TOKEN',
    'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_CONFIG__AUTHTOKEN',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'AZURE_CLIENT_SECRET', 'ARM_CLIENT_SECRET', 'GOOGLE_APPLICATION_CREDENTIALS',
    'VAULT_TOKEN', 'PGPASSWORD', 'DATABASE_URL', 'SENTRY_DSN',
    'SSH_AUTH_SOCK', 'SLACK_TOKEN', 'STRIPE_SECRET_KEY', 'OPENAI_API_KEY',
    'MY_SERVICE_API_KEY', 'SOME_ACCESS_KEY', 'TEAM_PASSWORD', 'PROJECT_WEBHOOK_URL',
  ])('drops %s', (name) => {
    expect(isCredentialVariable(name)).toBe(true);
  });

  it.each([
    'PATH', 'HOME', 'SHELL', 'LANG', 'TERM', 'NODE_OPTIONS', 'AWS_REGION', 'AWS_PROFILE',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'OPENCODE_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'GOOGLE_CLOUD_PROJECT', 'EDITOR', 'PWD',
  ])('keeps %s', (name) => {
    expect(isCredentialVariable(name)).toBe(false);
  });

  it('reads the name case-insensitively, as Windows environment names are', () => {
    expect(isCredentialVariable('github_token')).toBe(true);
    expect(isCredentialVariable('anthropic_api_key')).toBe(false);
  });
});
