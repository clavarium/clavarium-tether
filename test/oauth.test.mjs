/* THE OAUTH SOCLE, with no network: `fetch` is injected, so the token endpoints
 * are a tiny in-memory stand-in and the real request-shaping code runs. Nothing
 * here names a real account; the tokens are placeholders. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    PROVIDERS, provider, thunderbird, pkcePair, newState, scopeFor,
    consentUrl, extractCode, exchangeCode, refreshAccess, xoauth2,
} from '../host/oauth.mjs';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/* A stand-in token endpoint. It records each call and answers by grant_type;
   `code === 'bad'` fails, and `noRefresh` drops the refresh token. */
function tokenServer({ noRefresh = false } = {}) {
    const calls = [];
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    const fetch = async (url, opts = {}) => {
        const params = new URLSearchParams(opts.body);
        calls.push({ url, params, method: opts.method });
        const grant = params.get('grant_type');
        if (grant === 'authorization_code') {
            if (params.get('code') === 'bad') return json({ error: 'invalid_grant', error_description: 'bad code' }, 400);
            return json({ access_token: 'ACCESS1', ...(noRefresh ? {} : { refresh_token: 'REFRESH1' }), expires_in: 3600, scope: 'x' });
        }
        if (grant === 'refresh_token') return json({ access_token: 'ACCESS2', expires_in: 1800 });
        return json({ error: 'unsupported_grant_type' }, 400);
    };
    return { calls, fetch };
}

const REDIRECT = 'http://127.0.0.1:47591/';

test('the provider table carries both, with Thunderbird as default', () => {
    assert.deepEqual(Object.keys(PROVIDERS).sort(), ['google', 'microsoft']);
    assert.ok(provider('google').auth.startsWith('https://accounts.google.com/'));
    assert.ok(provider('microsoft').token.includes('login.microsoftonline.com'));
    assert.throws(() => provider('yahoo'), /unknown oauth provider/);
    const g = thunderbird('google');
    assert.ok(g.clientId && g.clientSecret, 'Google ships a client id and secret');
    const m = thunderbird('microsoft');
    assert.ok(m.clientId, 'Microsoft ships a client id');
    assert.equal(m.clientSecret, null, 'Microsoft is a public client: no secret');
});

test('pkcePair is a real S256 pair, url-safe', () => {
    const { verifier, challenge, method } = pkcePair();
    assert.equal(method, 'S256');
    assert.equal(challenge, b64url(createHash('sha256').update(verifier).digest()));
    for (const s of [verifier, challenge]) assert.doesNotMatch(s, /[+/=]/, 'base64url, not base64');
    assert.notEqual(pkcePair().verifier, pkcePair().verifier, 'fresh each time');
    assert.notEqual(newState(), newState());
});

test('scopeFor picks the kinds and appends the offline scope only where it is one', () => {
    assert.equal(scopeFor('google', ['mail']), 'https://mail.google.com/');
    assert.equal(scopeFor('google'), 'https://mail.google.com/', 'mail by default');
    const gBoth = scopeFor('google', ['mail', 'calendar']);
    assert.ok(gBoth.includes('https://mail.google.com/') && gBoth.includes('auth/calendar'));
    const m = scopeFor('microsoft', ['mail']);
    assert.ok(m.includes('IMAP.AccessAsUser.All'));
    assert.ok(m.split(' ').includes('offline_access'), 'Microsoft gets offline access as a scope');
    assert.throws(() => scopeFor('google', ['sms']), /no sms scope/);
});

test('consentUrl shapes a valid Google request (offline + PKCE + state)', () => {
    const url = new URL(consentUrl('google', {
        clientId: 'CID', redirectUri: REDIRECT, scope: scopeFor('google'),
        state: 'ST', codeChallenge: 'CH', loginHint: 'person@example.com',
    }));
    assert.ok(url.href.startsWith('https://accounts.google.com/o/oauth2/auth?'));
    const q = url.searchParams;
    assert.equal(q.get('client_id'), 'CID');
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('redirect_uri'), REDIRECT);
    assert.equal(q.get('access_type'), 'offline');
    assert.equal(q.get('prompt'), 'consent');
    assert.equal(q.get('code_challenge'), 'CH');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.equal(q.get('state'), 'ST');
    assert.equal(q.get('login_hint'), 'person@example.com');
});

test('consentUrl for Microsoft keeps offline_access in the scope', () => {
    const url = new URL(consentUrl('microsoft', { clientId: 'CID', redirectUri: REDIRECT, scope: scopeFor('microsoft'), state: 'ST', codeChallenge: 'CH' }));
    assert.ok(url.href.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?'));
    assert.ok(url.searchParams.get('scope').includes('offline_access'));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});

test('consentUrl refuses to build a broken request', () => {
    assert.throws(() => consentUrl('google', { redirectUri: REDIRECT, scope: 's', codeChallenge: 'C' }), /clientId/);
    assert.throws(() => consentUrl('google', { clientId: 'C', scope: 's', codeChallenge: 'C' }), /redirectUri/);
    assert.throws(() => consentUrl('google', { clientId: 'C', redirectUri: REDIRECT, codeChallenge: 'C' }), /scope/);
    assert.throws(() => consentUrl('google', { clientId: 'C', redirectUri: REDIRECT, scope: 's' }), /PKCE/);
});

test('extractCode reads the pasted loopback address, and guards it', () => {
    assert.equal(extractCode(`${REDIRECT}?code=ABC&state=ST`, { state: 'ST' }), 'ABC');
    assert.equal(extractCode(`${REDIRECT}?code=ABC`), 'ABC', 'no state asked, none needed');
    assert.throws(() => extractCode(`${REDIRECT}?code=ABC&state=OTHER`, { state: 'ST' }), /state mismatch/);
    assert.throws(() => extractCode(`${REDIRECT}?error=access_denied&error_description=nope`), /refused: nope/);
    assert.throws(() => extractCode(`${REDIRECT}?foo=bar`), /no code/);
    assert.throws(() => extractCode('not a url'), /not the address/);
});

test('exchangeCode trades a code for a refresh token (Google: secret + verifier)', async () => {
    const s = tokenServer();
    const t = await exchangeCode('google', { clientId: 'CID', clientSecret: 'SEC', redirectUri: REDIRECT, code: 'GOOD', codeVerifier: 'VER', fetch: s.fetch });
    assert.equal(t.accessToken, 'ACCESS1');
    assert.equal(t.refreshToken, 'REFRESH1');
    assert.ok(t.expiresAt > Date.now() + 3000_000, 'about an hour out');
    const sent = s.calls[0].params;
    assert.equal(sent.get('grant_type'), 'authorization_code');
    assert.equal(sent.get('client_secret'), 'SEC');
    assert.equal(sent.get('code_verifier'), 'VER');
    assert.equal(sent.get('redirect_uri'), REDIRECT);
});

test('exchangeCode for a public client sends no secret', async () => {
    const s = tokenServer();
    await exchangeCode('microsoft', { clientId: 'CID', clientSecret: null, redirectUri: REDIRECT, code: 'GOOD', codeVerifier: 'VER', fetch: s.fetch });
    assert.equal(s.calls[0].params.get('client_secret'), null);
    assert.equal(s.calls[0].params.get('code_verifier'), 'VER');
});

test('exchangeCode surfaces a provider refusal and a missing refresh token', async () => {
    const bad = tokenServer();
    await assert.rejects(() => exchangeCode('google', { clientId: 'C', redirectUri: REDIRECT, code: 'bad', fetch: bad.fetch }), /refused \(400\): bad code/);
    const none = tokenServer({ noRefresh: true });
    await assert.rejects(() => exchangeCode('google', { clientId: 'C', redirectUri: REDIRECT, code: 'GOOD', fetch: none.fetch }), /no refresh token/);
});

test('refreshAccess spends the refresh token and keeps it when none is returned', async () => {
    const s = tokenServer();
    const t = await refreshAccess('google', { clientId: 'CID', clientSecret: 'SEC', refreshToken: 'REFRESH1', fetch: s.fetch });
    assert.equal(t.accessToken, 'ACCESS2');
    assert.equal(t.refreshToken, 'REFRESH1', 'kept: the endpoint sent no new one');
    assert.ok(t.expiresAt > Date.now() + 1000_000);
    assert.equal(s.calls[0].params.get('grant_type'), 'refresh_token');
    assert.equal(s.calls[0].params.get('refresh_token'), 'REFRESH1');
});

test('xoauth2 builds the SASL initial response', () => {
    const got = xoauth2('person@example.com', 'ACCESS1');
    assert.equal(Buffer.from(got, 'base64').toString('utf8'), 'user=person@example.com\x01auth=Bearer ACCESS1\x01\x01');
    assert.throws(() => xoauth2('', 'T'), /needs a user/);
});
