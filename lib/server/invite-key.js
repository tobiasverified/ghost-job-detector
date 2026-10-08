import { createHmac, timingSafeEqual } from 'node:crypto';
import { clientIp, sendJson } from './http.js';

const KEY_LIMIT_MAX = 1000000;

export function inviteKeysRequired(env) {
  return /^true$/i.test(String(env?.REQUIRE_INVITE_KEY || '').trim());
}

function decodeBase64Url(value) {
  try {
    const text = String(value || '');

    if (!text || /[^A-Za-z0-9_-]/.test(text)) {
      return Buffer.alloc(0);
    }

    return Buffer.from(text, 'base64url');
  } catch {
    return Buffer.alloc(0);
  }
}

function signaturesMatch(payload, signature, secret) {
  const expected = createHmac('sha256', secret).update(String(payload || '')).digest();
  const actual = decodeBase64Url(signature);
  const sameLength = actual.length === expected.length;
  const compare = sameLength ? actual : Buffer.alloc(expected.length);
  return timingSafeEqual(compare, expected) && sameLength;
}

export function revokedKeyIds(env) {
  return String(env?.REVOKED_KEY_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function inviteHeader(req) {
  const value = req?.headers?.['x-ghd-key'];
  return String(Array.isArray(value) ? value[0] : value || '').trim();
}

// Signature and the env revocation list only. This does not touch the network.
export function verifyInviteKey(token, env = {}) {
  const text = String(token || '').trim();

  if (!text) {
    return { ok: false, error: 'invite_required', id: '', limit: null };
  }

  const secret = String(env?.INVITE_KEY_SECRET || '');
  const packed = text.startsWith('ghd_') ? text.slice(4) : '';
  const dot = packed.lastIndexOf('.');
  const payload = dot > 0 ? packed.slice(0, dot) : '';
  const signature = dot > 0 ? packed.slice(dot + 1) : '';
  const signed = Boolean(secret) && signaturesMatch(payload, signature, secret || ' ');

  if (!signed) {
    return { ok: false, error: 'invite_invalid', id: '', limit: null };
  }

  let parsed = null;

  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }

  const id = String(parsed?.id || '').trim();
  const limit = Number(parsed?.limit);

  if (!parsed || !id || id.length > 80 || !Number.isInteger(limit) || limit < 1 || limit > KEY_LIMIT_MAX) {
    return { ok: false, error: 'invite_invalid', id: '', limit: null };
  }

  if (revokedKeyIds(env).includes(id)) {
    return { ok: false, error: 'invite_invalid', id, limit: null };
  }

  return { ok: true, error: '', id, limit };
}

function sendRateLimited(res) {
  res.setHeader('Retry-After', '3600');
  sendJson(res, 429, { error: 'Rate limit exceeded. Try again in under an hour.' });
}

// Null means the response was already sent. A returned object is allowed
// through, with id and limit empty when invite keys are not required.
export async function enforceInvite(req, res, deps) {
  if (!inviteKeysRequired(deps?.env)) {
    return { ok: true, error: '', id: '', limit: null };
  }

  const verdict = verifyInviteKey(inviteHeader(req), deps.env);

  if (verdict.ok) {
    deps.paidQuota?.setInvite?.({ id: verdict.id, limit: verdict.limit });
    return verdict;
  }

  let limited = false;

  try {
    const result = await deps.rateLimit.consume(clientIp(req), deps.now);
    limited = result?.allowed === false;
    if (result) {
      res.setHeader('X-RateLimit-Limit', String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(result.limit - result.count, 0)));
    }
  } catch {
    limited = true;
  }

  if (limited) {
    sendRateLimited(res);
    return null;
  }

  console.info('[GHD] invite rejected', { error: verdict.error, keyId: verdict.id || '' });
  sendJson(res, 401, { error: verdict.error });
  return null;
}
