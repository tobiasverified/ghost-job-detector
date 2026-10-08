import { createHash, timingSafeEqual } from 'node:crypto';
import { sendJson } from './http.js';

export function cronAuthorized(authorization, secret) {
  const expected = `Bearer ${String(secret || '')}`;
  const got = String(authorization || '');
  const left = createHash('sha256').update(got).digest();
  const right = createHash('sha256').update(expected).digest();
  return Boolean(String(secret || '').length) && timingSafeEqual(left, right);
}

export function createCleanupHandler(overrides = {}) {
  return async function handler(req, res) {
    const env = overrides.env || process.env;
    const header = req.headers?.authorization || req.headers?.Authorization || '';

    if (!cronAuthorized(header, env.CRON_SECRET)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
    const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

    if (!url || !key) {
      sendJson(res, 503, { error: 'Cleanup is not configured' });
      return;
    }

    const rpcFetch = overrides.fetch || fetch;

    try {
      const response = await rpcFetch(`${url}/rest/v1/rpc/ghd_cleanup`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: '{}',
        signal: AbortSignal.timeout(8000)
      });

      if (!response.ok) {
        sendJson(res, 502, { error: 'Cleanup failed' });
        return;
      }

      sendJson(res, 200, await response.json());
    } catch (error) {
      console.info('[GHD] cleanup failed', {
        error: error instanceof Error ? error.message : 'failed'
      });
      sendJson(res, 502, { error: 'Cleanup failed' });
    }
  };
}
