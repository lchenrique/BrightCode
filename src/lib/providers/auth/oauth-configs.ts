/**
 * Predefined OAuth provider configurations.
 */

export interface OAuthConfig {
  providerId: string
  name: string
  clientId: string
  authorizeUrl: string
  tokenUrl: string
  scopes: string[]
  codeChallengeMethod?: 'S256' | 'plain'
  contentType?: 'application/x-www-form-urlencoded' | 'application/json'
  extraAuthParams?: Record<string, string>
}

export const OAUTH_CONFIGS: Record<string, OAuthConfig> = {
  openai: {
    providerId: 'openai',
    name: 'OpenAI (Codex)',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    codeChallengeMethod: 'S256',
    contentType: 'application/x-www-form-urlencoded',
    extraAuthParams: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    },
  },
  google: {
    providerId: 'google',
    name: 'Google Gemini',
    clientId: '764086051850-brightcode.apps.googleusercontent.com',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/cloud-platform',
    ],
    codeChallengeMethod: 'S256',
    contentType: 'application/x-www-form-urlencoded',
    extraAuthParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  },
  minimax: {
    providerId: 'minimax',
    name: 'MiniMax Portal',
    clientId: '78257093-7e40-4613-99e0-527b14b39113',
    authorizeUrl: 'https://api.minimax.io/oauth/code',
    tokenUrl: 'https://api.minimax.io/oauth/token',
    scopes: ['group_id', 'profile', 'model.completion'],
    codeChallengeMethod: 'S256',
    contentType: 'application/x-www-form-urlencoded',
  },
}
