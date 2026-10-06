import { cacheGet, cacheSet, createCache } from './cache.js';
import { applyCors, cleanString, clientIp, readJsonBody, requireClient, sendJson } from './http.js';
import { createRateLimiter } from './rateLimit.js';
import { askGroq } from './groq-client.js';

const IDENTITY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const WIKIDATA_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'GhostJobDetector/1.1 (https://ghost-job-detector-nine.vercel.app)'
};

const ORG_KEYWORDS = [
  'Health System',
  'Medical Center',
  'National Laboratory',
  'University',
  'College',
  'Hospital',
  'Corporation',
  'Foundation',
  'Laboratories',
  'Laboratory',
  'Observatory',
  'Institute',
  'Center',
  'Company',
  'Group',
  'Inc',
  'LLC'
];

function cleanLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isWeakAcronym(value) {
  return /^[A-Z]{2,3}$/.test(cleanLabel(value));
}

export function isNormalCompanyName(value) {
  const text = cleanLabel(value);

  if (!text || isWeakAcronym(text) || /career/i.test(text)) {
    return false;
  }

  if (!/\s/.test(text) && text === text.toLowerCase()) {
    return false;
  }

  return text.length > 3;
}

const PHRASE_TOKEN_CAP = 5;
const HEADING_WORDS = new Set(['who', 'we', 'are', 'our', 'about']);

function phraseTokens(before, splitHyphen) {
  const words = String(before || '').trim().split(/\s+/).filter(Boolean);
  const tokens = [];

  for (const word of words) {
    const parts = splitHyphen
      ? word.split(/(?<=[A-Za-z0-9])-(?=[A-Za-z0-9])/).filter(Boolean)
      : [word];

    parts.forEach((part, index) => {
      tokens.push({
        text: part,
        stop: splitHyphen && index < parts.length - 1
      });
    });
  }

  return tokens;
}

function walkOrganizationPhrase(tokens, keyword) {
  const kept = [];

  for (let index = tokens.length - 1; index >= 0 && kept.length < PHRASE_TOKEN_CAP; index -= 1) {
    if (tokens[index].stop) {
      break;
    }

    const raw = tokens[index].text;

    // A colon or period is a clause boundary. Judge it before punctuation is stripped,
    // and do not keep the token on that boundary.
    if (/[:.]$/.test(raw)) {
      break;
    }

    const token = raw.replace(/^[("'`“”]+|[)"'`,.;:]+$/g, '');

    if (!token) {
      continue;
    }

    // "Who We Are TKO" has no colon, and those four tokens still fit under the cap.
    if (HEADING_WORDS.has(token.toLowerCase())) {
      break;
    }

    if (/^(of|and|the|for|at|&)$/i.test(token)) {
      kept.unshift(token.toLowerCase());
      continue;
    }

    if (/^[A-Z0-9]/.test(token)) {
      kept.unshift(token);
      continue;
    }

    break;
  }

  while (kept.length && /^(the|a|an)$/i.test(kept[0])) {
    kept.shift();
  }

  const phrase = [...kept, keyword].join(' ').replace(/\s+/g, ' ').trim();
  const significant = phrase.split(' ').filter((word) => !/^(of|and|the|for|at|&)$/i.test(word));
  return significant.length >= 2 ? phrase : '';
}

function organizationPhraseBefore(before, keyword) {
  return [...new Set([
    walkOrganizationPhrase(phraseTokens(before, false), keyword),
    walkOrganizationPhrase(phraseTokens(before, true), keyword)
  ].filter(Boolean))];
}

function withLegalSuffix(phrase, after) {
  const match = String(after || '').match(
    /^\s+((?:[A-Z][A-Za-z]+,\s*)?(?:Inc\.?|LLC|L\.L\.C\.|Corp\.?|Corporation)\b(?:\s*\(NYSE:[^)]+\))?)/
  );

  if (!match) {
    return phrase;
  }

  return `${phrase} ${match[1]}`.replace(/\s+/g, ' ').trim();
}

function extractDescriptionCandidates(description, options = {}) {
  const normalized = String(description || '').replace(/\s+/g, ' ').trim();
  const text = options.full ? normalized : normalized.slice(0, 800);
  const found = [];

  for (const keyword of ORG_KEYWORDS) {
    const pattern = new RegExp(`\\b${keyword.replace(/\s+/g, '\\s+')}\\b`, 'g');
    let match = pattern.exec(text);

    while (match) {
      const phrases = organizationPhraseBefore(text.slice(0, match.index), keyword);

      for (const phrase of phrases) {
        found.push(withLegalSuffix(phrase, text.slice(match.index + match[0].length)));
      }

      match = pattern.exec(text);
    }
  }

  const candidates = [...new Set(found)];
  const head = normalized.slice(0, 800);
  console.info('[GHD] description candidates', {
    descriptionLength: String(description || '').length,
    window: head,
    groupHoldingsIndex: String(description || '').indexOf('Group Holdings'),
    inFirst800: head.includes('TKO Group Holdings'),
    candidates
  });
  return candidates;
}

function withoutInstitutionalSuffix(phrase) {
  const text = String(phrase || '').replace(/\s+/g, ' ').trim();
  const suffixes = [...ORG_KEYWORDS].sort((left, right) => right.length - left.length);

  for (const suffix of suffixes) {
    const pattern = new RegExp(`\\s+${suffix.replace(/\s+/g, '\\s+')}$`, 'i');

    if (!pattern.test(text)) {
      continue;
    }

    const stripped = text.replace(pattern, '').trim();
    const significant = stripped.split(/\s+/).filter((word) => word && !/^(of|and|the|for|at)$/i.test(word));
    return significant.length >= 2 ? stripped : '';
  }

  return '';
}

function identitySearchCandidates(description) {
  const extracted = extractDescriptionCandidates(description)
    .filter((candidate) => candidate.split(/\s+/).length >= 2);
  const all = [];

  for (const candidate of extracted) {
    all.push(candidate);
    const stripped = withoutInstitutionalSuffix(candidate);

    if (stripped) {
      all.push(stripped);
    }
  }

  return [...new Set(all)].sort((left, right) => right.length - left.length);
}

function compactIdentity(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function workdayHostFragment(hostname) {
  const hostMatch = String(hostname || '').match(/^(?:www\.)?([^.]+)\.wd\d+\.myworkdayjobs\.com$/i);
  return hostMatch ? hostMatch[1].replace(/[-_]+/g, ' ').trim() : '';
}

function hostFragment(signals) {
  const platform = String(signals?.platform || '').toUpperCase();
  const slug = cleanLabel(signals?.slug || '');

  // LinkedIn corroborates against the company-page slug. Workday has no slug;
  // an empty one must fall through to the career-site subdomain instead of
  // skipping Wikidata.
  if (platform === 'LINKEDIN' && slug) {
    return slug;
  }

  return workdayHostFragment(signals?.hostname) || slug;
}

function aliasCorroborates(alias, fragment) {
  const left = compactIdentity(alias);
  const host = compactIdentity(fragment);
  return Boolean(left && host && (left === host || left.includes(host)));
}

export function companyIdentityCacheKey(signals) {
  const platform = String(signals?.platform || '').toUpperCase();

  if (platform === 'LINKEDIN') {
    const slug = compactIdentity(signals?.slug || signals?.rawName || '');
    return slug ? `company-identity:v1:linkedin:${slug}` : '';
  }

  const host = String(signals?.hostname || '').trim().toLowerCase();
  return host ? `company-identity:v1:${host}` : '';
}

function readGroqName(text) {
  const line = String(text || '').trim().split('\n')[0].trim().replace(/^["']|["']$/g, '');

  if (!line || /^unknown$/i.test(line) || line.length > 120) {
    return '';
  }

  return line;
}

async function wikidataSearch(candidate, deps) {
  const url = new URL('https://www.wikidata.org/w/api.php');
  url.searchParams.set('action', 'wbsearchentities');
  url.searchParams.set('search', candidate);
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '5');
  url.searchParams.set('origin', '*');
  const response = await deps.fetch(url, {
    headers: WIKIDATA_HEADERS,
    signal: AbortSignal.timeout(8000)
  });
  const body = typeof response.text === 'function'
    ? await response.text()
    : JSON.stringify(await response.json());
  let payload = null;

  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }

  const hits = Array.isArray(payload?.search) ? payload.search : [];
  console.info('[GHD] identity wikidata search', {
    candidate,
    searchParam: url.searchParams.get('search'),
    commaEncoded: candidate.includes(',') ? url.toString().includes('%2C') : false,
    url: url.toString(),
    status: response.status,
    hits: hits.map((hit) => ({
      id: hit?.id || '',
      label: hit?.label || '',
      description: hit?.description || '',
      match: hit?.match?.text || ''
    })),
    body: hits.length ? '' : body.slice(0, 180)
  });

  if (!response.ok) {
    return [];
  }

  return hits;
}

async function wikidataEntity(id, deps) {
  const url = new URL('https://www.wikidata.org/w/api.php');
  url.searchParams.set('action', 'wbgetentities');
  url.searchParams.set('ids', id);
  url.searchParams.set('props', 'labels|aliases');
  url.searchParams.set('languages', 'en');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');
  const response = await deps.fetch(url, {
    headers: WIKIDATA_HEADERS,
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  return payload?.entities?.[id] || null;
}

function isSingleWordName(value) {
  const text = String(value || '').trim();
  return Boolean(text) && !/\s/.test(text);
}

function containsSiteWord(candidate, siteWord) {
  const word = String(siteWord || '').trim();

  if (!word) {
    return false;
  }

  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(String(candidate || ''));
}

function hiringOrganizationCandidate(organization, siteWord) {
  const cleaned = cleanLabel(String(organization || '').replace(/^\d+\s+/, ''));

  if (!cleaned || cleaned.length > 80 || !/\s/.test(cleaned)) {
    return '';
  }

  if (cleaned.toLowerCase() === String(siteWord || '').trim().toLowerCase()) {
    return '';
  }

  return containsSiteWord(cleaned, siteWord) ? cleaned : '';
}

function candidatesForBareName(signals, siteWord) {
  const phrases = extractDescriptionCandidates(signals?.description, { full: true })
    .filter((candidate) => (
      candidate.split(/\s+/).filter(Boolean).length >= 2
      && containsSiteWord(candidate, siteWord)
    ));
  const ordered = [...new Set(phrases)].sort((left, right) => right.length - left.length);
  const operator = hiringOrganizationCandidate(signals?.organization, siteWord);

  if (operator && !ordered.some((candidate) => candidate.toLowerCase() === operator.toLowerCase())) {
    ordered.push(operator);
  }

  return ordered;
}

async function corroborateWithWikidata(signals, deps, candidateList) {
  const fragment = hostFragment(signals);
  const candidates = Array.isArray(candidateList)
    ? candidateList
    : identitySearchCandidates(signals?.description);
  console.info('[GHD] identity wikidata candidates', {
    rawName: signals?.rawName || signals?.company || '',
    slug: signals?.slug || '',
    fragment,
    candidates
  });

  if (!fragment || !deps.fetch || !candidates.length) {
    console.info('[GHD] identity wikidata skipped', {
      fragment,
      hasFetch: Boolean(deps.fetch),
      candidateCount: candidates.length
    });
    return '';
  }

  for (const candidate of candidates) {
    let hits = [];

    try {
      hits = await wikidataSearch(candidate, deps);
    } catch (error) {
      console.info('[GHD] identity wikidata search error', candidate, error?.message || String(error));
      continue;
    }

    for (const hit of hits) {
      if (!hit?.id) {
        continue;
      }

      let entity = null;

      try {
        entity = await wikidataEntity(hit.id, deps);
      } catch (error) {
        console.info('[GHD] identity wikidata entity error', hit.id, error?.message || String(error));
        continue;
      }

      const label = entity?.labels?.en?.value || hit.label || '';
      const aliases = (entity?.aliases?.en || []).map((alias) => alias?.value || '').filter(Boolean);
      const names = [label, ...aliases];
      const matched = names.filter((name) => aliasCorroborates(name, fragment));
      console.info('[GHD] identity wikidata entity', {
        candidate,
        id: hit.id,
        label,
        aliases,
        fragment,
        matched,
        corroborated: matched.length > 0
      });

      if (!matched.length) {
        continue;
      }

      return label || candidate;
    }
  }

  console.info('[GHD] identity wikidata empty', { candidates, fragment });
  return '';
}

export async function resolveCompanyIdentity(signals, deps = {}) {
  const rawName = cleanLabel(signals?.rawName || signals?.company || '');
  const key = companyIdentityCacheKey({ ...signals, rawName });
  const now = deps.now || new Date();

  if (key && deps.cache) {
    const cached = await cacheGet(deps.cache, key, now);

    if (cached?.company) {
      console.info('[GHD] identity cache hit', { key, company: cached.company });
      return cached.company;
    }
  }

  if (isNormalCompanyName(rawName) && !isSingleWordName(rawName)) {
    console.info('[GHD] identity kept normal name', rawName);
    return rawName;
  }

  if (isNormalCompanyName(rawName)) {
    const candidates = candidatesForBareName(signals, rawName);
    console.info('[GHD] identity bare name candidates', { company: rawName, candidates });
    const corroborated = await corroborateWithWikidata(signals, deps, candidates);

    if (corroborated) {
      if (key && deps.cache) {
        await cacheSet(deps.cache, key, { company: corroborated }, IDENTITY_TTL_MS, now);
      }

      return corroborated;
    }

    console.info('[GHD] identity kept bare name', rawName);
    return rawName;
  }

  const corroborated = await corroborateWithWikidata(signals, deps);

  if (corroborated) {
    if (key && deps.cache) {
      await cacheSet(deps.cache, key, { company: corroborated }, IDENTITY_TTL_MS, now);
    }

    return corroborated;
  }

  const excerpt = String(signals?.description || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  let answered = '';

  console.info('[GHD] identity groq fallthrough', {
    rawName,
    excerptLength: excerpt.length,
    askGroq: typeof deps.askGroq === 'function'
  });

  if (typeof deps.askGroq === 'function' && excerpt) {
    const prompt = `Job posting hostname: ${signals?.hostname || ''}. Description excerpt: ${excerpt}. Based only on this text, what is the full, real name of the employer? If the text doesn't clearly state it, respond exactly UNKNOWN.`;
    console.info('[GHD] identity groq prompt', prompt);

    try {
      const raw = await deps.askGroq(prompt, {
        env: deps.env,
        fetch: deps.fetch,
        timeoutMs: 4000,
        temperature: 0
      });
      console.info('[GHD] identity groq raw', raw);
      answered = readGroqName(raw);
    } catch (error) {
      console.info('[GHD] identity groq error', error?.message || String(error));
      answered = '';
    }
  }

  if (!answered) {
    return rawName;
  }

  if (key && deps.cache) {
    await cacheSet(deps.cache, key, { company: answered }, IDENTITY_TTL_MS, now);
  }

  return answered;
}

function dependencies(overrides = {}) {
  const env = overrides.env || process.env;

  return {
    cache: overrides.cache || createCache(env),
    rateLimit: overrides.rateLimit || createRateLimiter(env),
    fetch: overrides.fetch || fetch,
    now: overrides.now || new Date(),
    env,
    askGroq: overrides.askGroq || ((prompt, options = {}) => askGroq(prompt, {
      ...options,
      env: options.env || env,
      fetch: options.fetch || overrides.fetch || fetch
    }))
  };
}

export function createCompanyIdentityHandler(overrides = {}) {
  return async function handler(req, res) {
    const deps = dependencies(overrides);
    console.info('[GHD] groq key check', {
      present: !!deps.env.GROQ_API_KEY,
      length: (deps.env.GROQ_API_KEY || '').length
    });
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!requireClient(req, res)) {
      return;
    }

    const limit = await deps.rateLimit.consume(clientIp(req), deps.now);
    res.setHeader('X-RateLimit-Limit', String(limit.limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(limit.limit - limit.count, 0)));

    if (!limit.allowed) {
      res.setHeader('Retry-After', '3600');
      sendJson(res, 429, { error: 'Rate limit exceeded. Try again in under an hour.' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const signals = {
        rawName: cleanString(body.rawName || body.company, 200),
        description: cleanString(body.description, 8000),
        hostname: cleanString(body.hostname, 200),
        platform: cleanString(body.platform, 40),
        slug: cleanString(body.slug, 120)
      };
      const company = await resolveCompanyIdentity(signals, deps);
      sendJson(res, 200, { company: company || signals.rawName });
    } catch {
      sendJson(res, 200, { company: '' });
    }
  };
}

export const companyIdentityHandler = createCompanyIdentityHandler();
