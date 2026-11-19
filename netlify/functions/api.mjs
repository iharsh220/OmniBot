// Netlify Function (Functions v2 format) running the OmniChat Express app via serverless-http.
//
// Why v2 and not `exports.handler`: in the older Lambda-compatible mode Netlify Blobs can't do
// strong-consistency reads ("uncachedEdgeURL" missing). v2 gives Blobs full support, so here we
// adapt the v2 Request → a Lambda-style event for serverless-http, and its result → a Response.
import './_env.mjs'; // must be first: switches storage to Netlify Blobs
import serverless from 'serverless-http';
import app from '../../server/app.js';

const run = serverless(app);

export default async (req, context) => {
  const url = new URL(req.url);
  const headers = {};
  const multiValueHeaders = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
    multiValueHeaders[key] = [value];
  });
  // Fetch Requests don't carry a Host header; the CSRF check (sameOrigin) needs it.
  if (!headers.host) {
    headers.host = url.host;
    multiValueHeaders.host = [url.host];
  }
  if (context?.ip) {
    headers['x-forwarded-for'] = context.ip;
    multiValueHeaders['x-forwarded-for'] = [context.ip];
  }
  const query = {};
  const multiQuery = {};
  for (const [k, v] of url.searchParams) {
    query[k] = v;
    (multiQuery[k] ||= []).push(v);
  }
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const raw = hasBody ? Buffer.from(await req.arrayBuffer()) : null;

  const result = await run({
    httpMethod: req.method,
    path: url.pathname,
    headers,
    multiValueHeaders,
    queryStringParameters: query,
    multiValueQueryStringParameters: multiQuery,
    body: raw && raw.length ? raw.toString('base64') : null,
    isBase64Encoded: !!(raw && raw.length),
    requestContext: { identity: { sourceIp: context?.ip } },
  }, {});

  const out = new Headers();
  for (const [k, v] of Object.entries(result.headers || {})) out.set(k, String(v));
  for (const [k, values] of Object.entries(result.multiValueHeaders || {})) {
    out.delete(k);
    for (const v of values) out.append(k, String(v));
  }
  const noBody = [204, 304].includes(result.statusCode) || req.method === 'HEAD';
  const body = noBody || !result.body ? null : result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body;
  return new Response(body, { status: result.statusCode, headers: out });
};

// Routes handled by this function (no netlify.toml redirects needed for these).
export const config = { path: ['/api/*', '/auth/*', '/webhooks/*'] };
