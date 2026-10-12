'use strict';

/**
 * Transport layer for downloads.
 *
 * One interface, two configurations:
 *
 *   transport(url) -> Promise<{ statusCode, headers, body: Readable }>
 *
 * Both use Node's http/https. Chromium's stack (`electron.net.request`) was the
 * obvious first choice because it carries the session's cookies automatically,
 * but against the real CDN it never produced a response and every download died
 * on the timeout — the client installs its own certificate verification layer
 * for `strm.yandex.net`, which is the likely cause. Node's TLS stack validates
 * the public certificate normally, so the account cookies are read from the
 * session explicitly and sent as a header instead.
 *
 * A second trap worth remembering: with `redirect: 'manual'` Electron emits a
 * `redirect` event rather than `response`, so a request that is never told to
 * `followRedirect()` simply hangs. Node's transport follows redirects itself.
 */

const http = require('node:http');
const https = require('node:https');

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
/** A request that never answers must fail loudly rather than hang forever. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Node http/https transport, with optional async header injection.
 *
 * Used both for tests (no headers) and for real downloads. The real path needs
 * the account cookies, which are read from the client's own session.
 */
function createNodeTransport(options = {}) {
  const { headersFor = null, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  return function nodeTransport(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https:') ? https : http;

      const start = (headers) => {
        const request = lib.get(url, { headers }, (response) => {
          if (REDIRECT_CODES.has(response.statusCode) && response.headers.location) {
            response.resume();
            if (redirectCount >= MAX_REDIRECTS) {
              reject(new Error('too many redirects'));
              return;
            }
            const next = new URL(response.headers.location, url).toString();
            nodeTransport(next, redirectCount + 1).then(resolve, reject);
            return;
          }
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: response,
          });
        });

        // A stalled socket must fail loudly instead of hanging the download.
        request.setTimeout(timeoutMs, () => {
          request.destroy(new Error(`timeout after ${timeoutMs} ms`));
        });
        request.on('error', reject);
      };

      if (!headersFor) {
        start({});
        return;
      }
      Promise.resolve()
        .then(() => headersFor(url))
        .then(start, reject);
    });
  };
}

/**
 * Production transport.
 *
 * `electron.net.request` looked like the natural choice because it carries the
 * session's cookies automatically, but against the real CDN it never produced a
 * response and every download died on the timeout. The client installs its own
 * certificate verification layer for `strm.yandex.net`, which is the likely
 * cause. Node's TLS stack validates the public certificate normally, so the
 * cookies are read from the session explicitly and attached as a header.
 */
function createSessionTransport(session, options = {}) {
  const referer = options.referer ?? 'https://music.yandex.ru/';
  const userAgent =
    options.userAgent ??
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

  return createNodeTransport({
    timeoutMs: options.timeoutMs,
    headersFor: async (url) => {
      const headers = { Referer: referer, 'User-Agent': userAgent };
      try {
        const cookies = await session.cookies.get({ url });
        if (Array.isArray(cookies) && cookies.length) {
          headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
        }
      } catch {
        // Cookies are a bonus: the stream URL is already signed.
      }
      return headers;
    },
  });
}

module.exports = {
  createNodeTransport,
  createSessionTransport,
  REDIRECT_CODES,
  MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
};
