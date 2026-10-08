import { createHash, createHmac, randomBytes } from 'node:crypto';

// First existing server secret used when IP_HASH_SECRET is unset.
const FALLBACK_SECRET_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'TAVILY_API_KEY',
  'GROQ_API_KEY',
  'RAPIDAPI_KEY',
  'NEWSDATA_API_KEY'
];

let warned = false;

export function resetIpHashWarning() {
  warned = false;
}

function derivedKey(source, value) {
  return createHash('sha256').update(`ghd-ip-hash\0${source}\0${value}`).digest();
}

function warnOnce(source) {
  if (warned) {
    return;
  }

  warned = true;
  console.info('[GHD] IP_HASH_SECRET missing', { fallback: source });
}

// HMAC key for an address. A dedicated secret is used as-is. Otherwise the
// key is derived from the first server secret that is already configured.
export function ipHashMaterial(env = process.env) {
  const dedicated = String(env?.IP_HASH_SECRET || '').trim();

  if (dedicated) {
    return { key: dedicated, source: 'IP_HASH_SECRET' };
  }

  for (const name of FALLBACK_SECRET_NAMES) {
    const value = String(env?.[name] || '').trim();

    if (value) {
      warnOnce(name);
      return { key: derivedKey(name, value), source: name };
    }
  }

  if (!globalThis.__ghdIpHashFallback) {
    globalThis.__ghdIpHashFallback = randomBytes(32);
  }

  warnOnce('process-random');
  return { key: globalThis.__ghdIpHashFallback, source: 'process-random' };
}

export function hashIp(ip, env = process.env) {
  const { key } = ipHashMaterial(env);
  return createHmac('sha256', key).update(String(ip || 'unknown')).digest('hex');
}
