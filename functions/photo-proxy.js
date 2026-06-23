// Netlify Function: photo-proxy
//
// GET /.netlify/functions/photo-proxy?url=<encoded-supabase-storage-url>
//
// Proxies contact photos from Supabase storage so the browser fetches them
// from the same Netlify origin — bypasses CORS restrictions and Edge's
// Tracking Prevention that blocks third-party storage access.

const https = require('https');
const http  = require('http');
const { URL } = require('url');

const ALLOWED_HOST = 'supabase.co';
const ALLOWED_PATH_PREFIX = '/storage/v1/object/public/letters/contact-photos/';

exports.handler = async (event) => {
  const rawUrl = event.queryStringParameters && event.queryStringParameters.url;
  if (!rawUrl) return { statusCode: 400, body: 'Missing url param' };

  let parsed;
  try { parsed = new URL(decodeURIComponent(rawUrl)); } catch { return { statusCode: 400, body: 'Invalid url' }; }

  if (!parsed.hostname.endsWith(ALLOWED_HOST) || !parsed.pathname.startsWith(ALLOWED_PATH_PREFIX)) {
    return { statusCode: 403, body: 'URL not allowed' };
  }

  return new Promise((resolve) => {
    const lib = parsed.protocol === 'https:' ? https : http;
    lib.get(parsed.toString(), { timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: {
            'Content-Type': res.headers['content-type'] || 'image/jpeg',
            'Cache-Control': 'public, max-age=86400',
          },
          body: buf.toString('base64'),
          isBase64Encoded: true,
        });
      });
    }).on('error', err => {
      console.error('[photo-proxy] fetch error:', err.message);
      resolve({ statusCode: 502, body: 'Upstream error' });
    });
  });
};
