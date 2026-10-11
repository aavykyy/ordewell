import { describe, expect, it } from 'vitest';
import { carriesSecret, sensitiveEnvValues } from '../outboundSecrets';

describe('outbound environment secrets', () => {
  it('recognizes references by variable name rather than secret punctuation', () => {
    const secrets = sensitiveEnvValues({
      SERVICE_SECRET: '/AbC1234/base64Secret=',
      SERVICE_PASSWORD: 'user:password123',
      SERVICE_TOKEN: 'token:AbCd1234',
      SERVICE_KEY_URL: 'https://vault.example/key',
      SERVICE_SECRET_URI: 'vault:secret-reference',
      SERVICE_TOKEN_PATH: '/run/token',
      SERVICE_KEY_FILE: './key.pem',
      SERVICE_CREDENTIAL_DIR: '/run/credentials',
      ORDINARY_SETTING: 'unrelated-value',
    });
    expect(secrets).toEqual(['/AbC1234/base64Secret=', 'user:password123', 'token:AbCd1234']);
    expect(carriesSecret(['https://example.com/?q=%2FAbC1234%2Fbase64Secret%3D'], secrets)).toBe(true);
    expect(carriesSecret(['q=user%3Apassword123'], secrets)).toBe(true);
  });
});
