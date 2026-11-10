/**
 * Access rules of the web UI server (ui/server.cjs), as pure functions.
 *
 * The dashboard serves whole conversations, tool inputs and facts with no
 * login. It is a local tool: it listens on the loopback address, answers only
 * requests that a browser on this machine made to it directly, and sends no
 * CORS headers. Anything wider is an explicit choice with a token:
 *
 *   MEMORY_BANK_UI_HOST   listen address (default 127.0.0.1). A non-loopback
 *                         address is refused unless MEMORY_BANK_UI_TOKEN is set.
 *   MEMORY_BANK_UI_TOKEN  when set, every dashboard page and API needs it
 *                         (Authorization: Bearer, or the cookie that
 *                         `/?token=…` sets once).
 *   HUE_OS_PUBLIC_PORT    second loopback listener that serves the Hue OS chat
 *                         routes and nothing else — the only port a tunnel may
 *                         point at. Needs REPLACEMENT_OS_ACCESS_PASSWORD.
 *   MEMORY_BANK_UI_TRUST_PROXY
 *                         `1` = on the dashboard port, count the Hue OS login
 *                         limit and daily quota per X-Forwarded-For address
 *                         instead of the connection's own (clientAddress).
 *                         Only behind a proxy you run: otherwise the caller
 *                         types the header. The public listener always reads it.
 */
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3847;
const MIN_TOKEN_LENGTH = 16;
const UI_TOKEN_COOKIE = 'memory_bank_ui_token';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PAGE_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_TRANSLATE_ITEMS = 50;
const MAX_TRANSLATE_CHARS = 2000;

// Headers a reverse proxy or tunnel adds. A request carrying one did not come
// straight from a local browser.
const PROXY_HEADERS = [
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
  'cf-connecting-ip', 'cf-ray', 'true-client-ip', 'x-vercel-forwarded-for', 'x-hue-os-vercel-bridge',
  'tailscale-funnel-request', 'ngrok-trace-id', 'via',
];

const HUE_OS_PAGES = new Set(['/hue-os', '/replacement-os', '/os', '/replacement']);

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message || code);
    this.statusCode = statusCode;
    this.payload = { error: code, ...(message ? { message } : {}) };
  }
}

function isLoopbackHostname(hostname) {
  const name = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '::1' || /^127(\.\d{1,3}){3}$/.test(name);
}

function parsePort(raw, name, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const text = String(raw).trim();
  if (!/^\d{1,5}$/.test(text) || Number(text) > 65535) {
    throw new Error(`${name}=${JSON.stringify(raw)} is not a port (0-65535)`);
  }
  return Number(text);
}

/**
 * Where the server may listen. Throws (the server must not start) when the
 * configuration asks for more exposure than it secures.
 */
function resolveListenConfig(env = process.env) {
  const host = String(env.MEMORY_BANK_UI_HOST || '').trim() || DEFAULT_HOST;
  const port = parsePort(env.PORT, 'PORT', DEFAULT_PORT);
  const token = env.MEMORY_BANK_UI_TOKEN ? String(env.MEMORY_BANK_UI_TOKEN) : null;
  if (token !== null && token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`MEMORY_BANK_UI_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters — use a long random value (e.g. \`openssl rand -hex 32\`)`);
  }
  if (!isLoopbackHostname(host) && token === null) {
    throw new Error(
      `MEMORY_BANK_UI_HOST=${host} would serve every indexed conversation to the network with no login. ` +
      `Set MEMORY_BANK_UI_TOKEN (${MIN_TOKEN_LENGTH}+ characters) to listen there, or unset MEMORY_BANK_UI_HOST to stay on ${DEFAULT_HOST}.`,
    );
  }
  const publicPort = parsePort(env.HUE_OS_PUBLIC_PORT, 'HUE_OS_PUBLIC_PORT', null);
  if (publicPort !== null) {
    if (!env.REPLACEMENT_OS_ACCESS_PASSWORD) {
      throw new Error('HUE_OS_PUBLIC_PORT is set but REPLACEMENT_OS_ACCESS_PASSWORD is not — the public Hue OS listener needs an access password');
    }
    if (publicPort !== 0 && publicPort === port) {
      throw new Error('HUE_OS_PUBLIC_PORT must differ from PORT — the dashboard port is never the public one');
    }
  }
  return { host, port, token, publicPort, localOnly: isLoopbackHostname(host) };
}

/** Database path, by the same precedence as src/paths.ts. */
function resolveDbPath(env = process.env) {
  if (env.MEMORY_BANK_DB_PATH || env.TEST_DB_PATH) return env.MEMORY_BANK_DB_PATH || env.TEST_DB_PATH;
  let dir;
  if (env.MEMORY_BANK_CONFIG_DIR) dir = env.MEMORY_BANK_CONFIG_DIR;
  else if (env.PERSONAL_SUPERPOWERS_DIR) dir = env.PERSONAL_SUPERPOWERS_DIR;
  else if (env.XDG_CONFIG_HOME) dir = path.join(env.XDG_CONFIG_HOME, 'superpowers');
  else dir = path.join(os.homedir(), '.config', 'superpowers');
  return path.join(dir, 'conversation-index', 'db.sqlite');
}

function isHueOsApi(pathname) {
  return pathname.startsWith('/api/hue-os/') || pathname.startsWith('/api/replacement-os/');
}

function isHueOsRoute(pathname) {
  return HUE_OS_PAGES.has(pathname) || isHueOsApi(pathname);
}

function hostnameOfHostHeader(hostHeader) {
  const value = String(hostHeader || '').trim();
  if (!value) return null;
  try {
    return new URL(`http://${value}`).hostname;
  } catch (_) {
    return null;
  }
}

function proxyHeaderOf(headers) {
  return PROXY_HEADERS.find((name) => headers[name] !== undefined) || null;
}

/** True when the Origin header (if any) names the origin the request itself was sent to. */
function isSameOrigin(headers) {
  const origin = headers.origin;
  if (origin === undefined) return true; // not a cross-origin browser request (those always carry Origin on POST/CORS)
  try {
    return new URL(origin).host === String(headers.host || '');
  } catch (_) {
    return false; // "null" (sandboxed frame, file://) or garbage
  }
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function parseCookieHeader(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) continue;
    try { cookies[rawKey] = decodeURIComponent(rawValue.join('=') || ''); }
    catch (_) { cookies[rawKey] = rawValue.join('='); }
  }
  return cookies;
}

function presentedToken(headers) {
  const auth = String(headers.authorization || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  return parseCookieHeader(headers.cookie)[UI_TOKEN_COOKIE] || null;
}

/**
 * Whether the dashboard listener answers this request.
 * Returns null (go on), `{ status, error, message }` (refuse), or
 * `{ setTokenCookie: true }` (a valid `?token=`: set the cookie and redirect).
 */
function checkLocalAccess({ method, headers, pathname, searchParams }, config) {
  if (!isSameOrigin(headers)) {
    return { status: 403, error: 'cross_origin', message: 'This server answers same-origin requests only.' };
  }
  const fetchSite = headers['sec-fetch-site'];
  if (pathname.startsWith('/api/') && fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return { status: 403, error: 'cross_origin', message: 'This server answers same-origin requests only.' };
  }

  if (config.token === null) {
    // No token: the only caller is a browser on this machine talking to us directly.
    const hostname = hostnameOfHostHeader(headers.host);
    if (!hostname || !isLoopbackHostname(hostname)) {
      return { status: 403, error: 'local_only', message: 'This port serves the local dashboard only. Open it as http://localhost:<port>; a tunnel may point at HUE_OS_PUBLIC_PORT only.' };
    }
    const proxied = proxyHeaderOf(headers);
    if (proxied) {
      return { status: 403, error: 'local_only', message: `This port serves the local dashboard only and does not answer proxied requests (${proxied}). A tunnel may point at HUE_OS_PUBLIC_PORT only.` };
    }
    return null;
  }

  // Token mode. Hue OS routes keep their own password login.
  if (isHueOsRoute(pathname)) return null;
  const presented = presentedToken(headers);
  if (presented && safeEqual(presented, config.token)) return null;
  const queryToken = searchParams.get('token');
  if (method === 'GET' && !pathname.startsWith('/api/') && queryToken && safeEqual(queryToken, config.token)) {
    return { setTokenCookie: true };
  }
  return { status: 401, error: 'token_required', message: 'Send Authorization: Bearer <MEMORY_BANK_UI_TOKEN>, or open /?token=<MEMORY_BANK_UI_TOKEN> once in the browser.' };
}

function parseBoundedInt(raw, { name, fallback, min, max }) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (!/^\d{1,9}$/.test(String(raw))) throw new HttpError(400, `invalid_${name}`, `${name} must be an integer ≥ ${min}`);
  const value = Number(raw);
  if (value < min) throw new HttpError(400, `invalid_${name}`, `${name} must be an integer ≥ ${min}`);
  return max === undefined ? value : Math.min(value, max);
}

/** `limit` (1-200, larger values capped) and `offset` (≥ 0) of a list API. Anything else is a 400, never "no limit". */
function parsePaging(params) {
  return {
    limit: parseBoundedInt(params.get('limit'), { name: 'limit', fallback: DEFAULT_PAGE_LIMIT, min: 1, max: MAX_PAGE_LIMIT }),
    offset: parseBoundedInt(params.get('offset'), { name: 'offset', fallback: 0, min: 0 }),
  };
}

/** The texts of a /api/translate body: an array of at most 50 strings of at most 2,000 characters each. */
function parseTranslateTexts(body) {
  const texts = body && body.texts;
  if (texts === undefined) return [];
  if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string')) {
    throw new HttpError(400, 'invalid_texts', 'texts must be an array of strings');
  }
  if (texts.length > MAX_TRANSLATE_ITEMS) {
    throw new HttpError(400, 'too_many_texts', `at most ${MAX_TRANSLATE_ITEMS} texts per request`);
  }
  if (texts.some((t) => t.length > MAX_TRANSLATE_CHARS)) {
    throw new HttpError(400, 'text_too_long', `each text is at most ${MAX_TRANSLATE_CHARS} characters`);
  }
  return texts;
}

/**
 * JSON for an inline <script>. JSON.stringify leaves `</script>`, `<!--` and
 * U+2028/2029 as they are, so a stored string could end the script element (or
 * the string literal) and continue as markup. Escaped, the JS parser reads back
 * exactly the same value.
 */
function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The client address a quota or login limit is counted against. X-Forwarded-For
 * is whatever the caller typed unless a proxy we run put it there, so it is
 * read only where that is the case (the public Hue OS listener, or
 * MEMORY_BANK_UI_TRUST_PROXY=1).
 */
function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  MIN_TOKEN_LENGTH,
  UI_TOKEN_COOKIE,
  MAX_BODY_BYTES,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
  MAX_TRANSLATE_ITEMS,
  MAX_TRANSLATE_CHARS,
  PROXY_HEADERS,
  HUE_OS_PAGES,
  HttpError,
  isLoopbackHostname,
  resolveListenConfig,
  resolveDbPath,
  isHueOsApi,
  isHueOsRoute,
  proxyHeaderOf,
  isSameOrigin,
  safeEqual,
  parseCookieHeader,
  presentedToken,
  checkLocalAccess,
  parsePaging,
  parseTranslateTexts,
  safeJsonForScript,
  clientAddress,
};
