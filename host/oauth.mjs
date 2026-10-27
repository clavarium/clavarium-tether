/* THE OAUTH SOCLE -- user-delegated access to Gmail and Microsoft (mail today,
 * calendar and files next), so a mailbox is reached by a token and never a
 * stored password. It is the shape Thunderbird uses: keep IMAP/SMTP, but
 * AUTHENTICATE with a bearer token instead of LOGIN, and get that token from an
 * OAuth consent the person gives in their own browser.
 *
 * THE RUSE, AND WHY A CLIENT ID SITS HERE. Google and Microsoft only let a
 * *registered* application ask for consent. Registering one per installation is
 * exactly what an open, self-hosted project cannot ask of everybody, so instead
 * we present ourselves with Thunderbird's own built-in client -- the id (and, for
 * Google, the secret) that ship, in the open, in Mozilla's source
 * (comm-central mailnews/base/src/OAuth2Providers.sys.mjs). These are installed-
 * app / public-client credentials: not a secret in the real sense (anyone who has
 * Thunderbird has them), and that is why reusing them is sound. Mozilla's file
 * says "don't copy these for your own application" -- we copy them *as*
 * Thunderbird, deliberately, with the operator's decision, and the consent window
 * tells the person plainly that this is what Clavarium does. A deployment that
 * would rather register its own application sets its own clientId/secret and
 * never touches the defaults below.
 *
 * NOTHING AUTOMATES THE LOGIN. The person signs in to Google/Microsoft in their
 * own real browser, however they normally do (password, passkey, YubiKey, 2FA) --
 * we never see or type a credential. All we ever handle is the authorization
 * `code` the provider hands back to a loopback address, and the refresh token we
 * trade it for. Capturing that code is the host's business (a pasted address, or
 * the browser extension): this file is only the OAuth arithmetic, and takes an
 * injected `fetch` so it runs under test with no network.
 */
import { createHash, randomBytes } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/* Per-provider endpoints, the scopes we may ask for by kind, and a built-in,
   already-verified open-source desktop client as the default (the `thunderbird`
   field). We borrow THUNDERBIRD's own client for BOTH providers: each registered
   the loopback 127.0.0.1 redirect on any port, so the person always lands on the
   same copy-pastable http://127.0.0.1 address. Google's client is cleared for mail
   + CalDAV + CardDAV; Microsoft's (a multitenant public client) takes mail,
   calendar and contacts over Graph by dynamic consent. `consentExtra` is what a
   provider needs on the consent URL to return a refresh token; `offlineScope` is
   the same thing when it is a scope rather than a parameter (Microsoft). */
export const PROVIDERS = {
    google: {
        label: 'Google',
        auth: 'https://accounts.google.com/o/oauth2/auth',
        token: 'https://oauth2.googleapis.com/token',
        pkce: true,
        consentExtra: { access_type: 'offline', prompt: 'consent' },
        offlineScope: null,
        scopes: {
            mail: 'https://mail.google.com/',
            calendar: 'https://www.googleapis.com/auth/calendar',
            contacts: 'https://www.googleapis.com/auth/carddav',
        },
        /* Thunderbird's own built-in Google client (open source, embedded secret
           sanctioned by Google for an installed app; comm-central
           OAuth2Providers.sys.mjs). Its GOOGLE_SCOPES carry mail AND CalDAV AND
           CardDAV, so one consent gives all three on the same loopback 127.0.0.1
           redirect -- one borrowed identity (Thunderbird) for both providers. */
        thunderbird: {
            clientId: '406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com',
            clientSecret: 'kSmqreRr0qwBWJgbf5Y-PjSU',
        },
    },
    microsoft: {
        label: 'Microsoft',
        auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        pkce: true,
        consentExtra: {},
        offlineScope: 'offline_access',
        /* Microsoft over Graph: mail, calendar and contacts all go through
           graph.microsoft.com (the mail connector uses its Graph path for
           Microsoft). mail.send is needed to send. Thunderbird's public client
           takes these delegated scopes by dynamic consent. */
        scopes: {
            mail: 'mail.readwrite mail.send',
            calendar: 'calendars.readwrite',
            contacts: 'contacts.readwrite',
        },
        /* Thunderbird's built-in Microsoft client (open source, public, no secret;
           comm-central OAuth2Providers.sys.mjs). It registered the loopback
           127.0.0.1 redirect on ANY port, so we reuse the same http://127.0.0.1
           address as Google. */
        thunderbird: {
            clientId: '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
            clientSecret: null,
        },
    },
};

export function provider(name) {
    const p = PROVIDERS[name];
    if (!p) throw new Error(`unknown oauth provider: ${name}`);
    return p;
}

/* Thunderbird's built-in client for a provider -- the default when a deployment
   has not set its own. Returned as a fresh object so a caller may override it. */
export function thunderbird(name) {
    const { clientId, clientSecret } = provider(name).thunderbird;
    return { clientId, clientSecret };
}

/* A PKCE pair: a random verifier kept by the host, and the S256 challenge put on
   the consent URL. Both providers accept (Microsoft's public client needs) PKCE. */
export function pkcePair() {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    return { verifier, challenge, method: 'S256' };
}

/* An opaque value to tie a consent to the request that started it, so a stray or
   forged redirect is refused (see extractCode). */
export function newState() { return b64url(randomBytes(16)); }

/* The scope string for the kinds wanted (default: mail), de-duplicated, with the
   provider's offline scope appended when it has one. */
export function scopeFor(name, kinds = ['mail']) {
    const p = provider(name);
    const parts = [];
    for (const k of kinds) {
        const s = p.scopes[k];
        if (!s) throw new Error(`${p.label} has no ${k} scope here`);
        parts.push(...s.split(/\s+/).filter(Boolean));
    }
    if (p.offlineScope) parts.push(p.offlineScope);
    return [...new Set(parts)].join(' ');
}

/* The URL the person's browser opens to sign in and allow. `redirectUri` is the
   loopback the provider sends the code back to (http://127.0.0.1:PORT). */
export function consentUrl(name, { clientId, redirectUri, scope, state, codeChallenge, loginHint } = {}) {
    const p = provider(name);
    if (!clientId) throw new Error('consentUrl needs a clientId');
    if (!redirectUri) throw new Error('consentUrl needs a redirectUri');
    if (!scope) throw new Error('consentUrl needs a scope');
    const q = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope,
        ...(state ? { state } : {}),
        ...p.consentExtra,
    });
    if (p.pkce) {
        if (!codeChallenge) throw new Error(`${p.label} requires PKCE: pass codeChallenge`);
        q.set('code_challenge', codeChallenge);
        q.set('code_challenge_method', 'S256');
    }
    if (loginHint) q.set('login_hint', loginHint);
    return `${p.auth}?${q.toString()}`;
}

/* Pull the authorization code out of the address the browser lands on after the
   person allows -- the loopback URL they paste back, or that the extension reads.
   Verifies the state when one is given, and turns an `error=...` redirect into a
   plain message. */
export function extractCode(redirected, { state } = {}) {
    let u;
    try { u = new URL(String(redirected ?? '').trim()); } catch { throw new Error('that is not the address the provider sent back'); }
    const q = u.searchParams;
    const err = q.get('error');
    if (err) throw new Error(`the provider refused: ${q.get('error_description') || err}`);
    const code = q.get('code');
    if (!code) throw new Error('that address carries no code -- paste the whole address from the bar after you allow');
    const got = q.get('state');
    if (state && got && got !== state) throw new Error('that address does not match this request (state mismatch)');
    return code;
}

async function postToken(name, params, fetchImpl) {
    const p = provider(name);
    const body = new URLSearchParams(params);
    let res;
    try {
        res = await fetchImpl(p.token, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: body.toString(),
        });
    } catch (e) { throw new Error(`cannot reach the ${p.label} token service: ${e?.message ?? e}`); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${p.label} token service refused (${res.status}): ${j.error_description || j.error || 'no detail'}`);
    return j;
}

/* access_token + refresh_token + a wall-clock expiry (ms). */
function tokenShape(j) {
    return {
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
        scope: j.scope,
    };
}

/* Trade the authorization code for the first refresh token (consent, once per
   mailbox). Google's installed-app client sends its secret and the PKCE verifier;
   Microsoft's public client sends the verifier only. */
export async function exchangeCode(name, { clientId, clientSecret, redirectUri, code, codeVerifier, fetch: fetchImpl = globalThis.fetch } = {}) {
    if (!clientId) throw new Error('exchangeCode needs a clientId');
    if (!code) throw new Error('exchangeCode needs a code');
    if (!redirectUri) throw new Error('exchangeCode needs the same redirectUri as the consent');
    const params = { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId };
    if (clientSecret) params.client_secret = clientSecret;
    if (codeVerifier) params.code_verifier = codeVerifier;
    const t = tokenShape(await postToken(name, params, fetchImpl));
    if (!t.accessToken) throw new Error(`${provider(name).label} gave no access token`);
    if (!t.refreshToken) throw new Error(`${provider(name).label} gave no refresh token -- the consent must ask for offline access`);
    return t;
}

/* Spend the refresh token for a fresh access token (every hour or so, at use).
   The provider may or may not hand back a new refresh token; keep the old one if
   it does not. */
export async function refreshAccess(name, { clientId, clientSecret, refreshToken, scope, fetch: fetchImpl = globalThis.fetch } = {}) {
    if (!clientId) throw new Error('refreshAccess needs a clientId');
    if (!refreshToken) throw new Error('refreshAccess needs a refreshToken');
    const params = { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId };
    if (clientSecret) params.client_secret = clientSecret;
    if (scope) params.scope = scope;
    const t = tokenShape(await postToken(name, params, fetchImpl));
    if (!t.accessToken) throw new Error(`${provider(name).label} gave no access token on refresh`);
    if (!t.refreshToken) t.refreshToken = refreshToken;
    return t;
}

/* The SASL XOAUTH2 initial response for an IMAP/SMTP AUTHENTICATE: the base64 of
   `user=<mail>^Aauth=Bearer <token>^A^A`. The mail connector will use this in
   place of LOGIN; kept here with the rest of the OAuth arithmetic. */
export function xoauth2(user, accessToken) {
    if (!user || !accessToken) throw new Error('xoauth2 needs a user and an access token');
    return Buffer.from(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`, 'utf8').toString('base64');
}
