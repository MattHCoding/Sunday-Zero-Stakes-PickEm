import { awsConfig as config } from './aws-config.mjs';
const redirectUri = 'https://matthcoding.github.io/Sunday-Zero-Stakes-PickEm/';
const domain = 'https://sunday-pickem-442426890475.auth.us-east-2.amazoncognito.com';
const key = 'pickem-oauth-transaction';
let session = null;
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
export function getSession() { return session && session.expiresAt > Date.now() ? session : null; }
export function getAccessToken() { return getSession()?.accessToken || null; }
export async function signIn() {
  const verifier = random(), state = random();
  const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(key, JSON.stringify({ verifier, state, createdAt: Date.now() }));
  const params = new URLSearchParams({ client_id: config.appClientId, response_type: 'code', redirect_uri: redirectUri,
    scope: 'openid email aws.cognito.signin.user.admin', state, code_challenge: challenge, code_challenge_method: 'S256' });
  location.assign(`${domain}/oauth2/authorize?${params}`);
}
export async function finishSignIn() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return;
  history.replaceState(null, '', location.pathname);
  const raw = sessionStorage.getItem(key);
  sessionStorage.removeItem(key);
  const transaction = raw ? JSON.parse(raw) : null;
  if (!transaction || params.get('state') !== transaction.state || Date.now() - transaction.createdAt > 600000)
    throw new Error('Sign-in expired or could not be verified. Please try again.');
  if (params.has('error')) throw new Error('Sign-in was cancelled or rejected. Please try again.');
  const response = await fetch(`${domain}/oauth2/token`, { method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.appClientId,
      redirect_uri: redirectUri, code: params.get('code'), code_verifier: transaction.verifier }) });
  if (!response.ok) throw new Error('Could not complete sign-in. Please try again.');
  const tokens = await response.json();
  const payload = tokens.access_token?.split('.')[1];
  if (!payload) throw new Error('Missing access token.');
  const claims = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/')));
  // These are client-side sanity checks; API Gateway verifies the JWT signature.
  if (claims.iss !== config.userPoolIssuer || claims.client_id !== config.appClientId || claims.token_use !== 'access' || !claims.sub || claims.exp * 1000 <= Date.now())
    throw new Error('Unexpected sign-in response.');
  session = { accessToken: tokens.access_token, userId: claims.sub, expiresAt: claims.exp * 1000 };
  // Tokens stay in memory. Reloading requires sign-in again (Cognito may reuse its session).
}
export function signOut() {
  session = null;
  sessionStorage.removeItem(key);
  location.assign(`${domain}/logout?${new URLSearchParams({ client_id: config.appClientId, logout_uri: redirectUri })}`);
}
