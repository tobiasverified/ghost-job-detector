export const GENERIC_TOKENS = new Set([
  'inc',
  'incorporated',
  'llc',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'group',
  'holdings',
  'holding',
  'technologies',
  'technology',
  'tech',
  'motors',
  'motor',
  'international',
  'global',
  'services',
  'service',
  'solutions',
  'systems',
  'system',
  'labs',
  'lab',
  'industries',
  'plc',
  'the',
  'and',
  'of',
  'platforms',
  'platform'
]);

// Industry words that belong in the full name, but are not a company by themselves.
export const STANDALONE_BLOCK = new Set([
  'residential',
  'apartments',
  'apartment',
  'homes',
  'home',
  'realty',
  'properties',
  'property',
  'management',
  'communities',
  'living',
  'housing',
  'education',
  'educational',
  'publishing',
  'publisher',
  'learning',
  'university',
  'college',
  'health',
  'healthcare',
  'medical',
  'hospital',
  'staffing',
  'staff',
  'operations',
  'laboratory',
  'program',
  'programs',
  'care',
  'candy',
  'foods',
  'food'
]);

const DIFFERENT_ORG = /^['’]s(?:\s+[a-z0-9&]+){0,4}\s+(?:company|co|inc|corp|corporation|llc|ltd|limited|group|brands?|foods?)\b/i;
const CANDY_ORG = /^['’]s\s+candy\b/i;

// A trailing parenthetical acronym is not part of the employer name.
// "Amazon Web Services (AWS)" is looked up as "Amazon Web Services".
// Words inside the parentheses are not aliases.
export function companyLookupName(name) {
  return String(name || '').trim().replace(/\s*\(([A-Z0-9]{2,12})\)\s*$/, '').trim();
}

export function normalizeCompany(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function companyCacheKey(name) {
  return normalizeCompany(name).replace(/\s+/g, '-');
}

/**
 * Full company name, plus one distinctive alias.
 * "Hyundai Supernal" is also searched as "supernal".
 * A trailing industry word is removed for a shorter core name:
 * "AMLI Residential" is also searched as "amli".
 */
export function companyQueries(name) {
  const normalized = normalizeCompany(companyLookupName(name));
  if (!normalized) {
    return [];
  }

  const rawTokens = normalized.split(' ');
  const hasOfPattern = rawTokens.includes('of');
  const tokens = rawTokens.filter((token) => token && !GENERIC_TOKENS.has(token));

  const queries = [];
  const fullName = tokens.join(' ');

  if (fullName) {
    queries.push(fullName);
  }

  // "University of Miami" must not also search as "miami".
  // "UMCareer Staff" must not also search as "staff".
  if (tokens.length >= 2 && !hasOfPattern) {
    const distinctive = tokens[tokens.length - 1];
    if (distinctive.length >= 4 && !STANDALONE_BLOCK.has(distinctive)) {
      queries.push(distinctive);
    }
  }

  let stripped = tokens.slice();
  while (stripped.length > 1 && STANDALONE_BLOCK.has(stripped[stripped.length - 1])) {
    stripped.pop();
  }
  const strippedName = stripped.join(' ');
  if (strippedName && strippedName !== fullName) {
    queries.push(strippedName);
  }

  return [...new Set(queries)];
}

export function shorterCompanyNames(name) {
  const original = companyLookupName(name);
  const originalKey = original.toLowerCase();
  const wordCount = original.split(/\s+/).filter(Boolean).length;

  return companyQueries(original).filter((query) => {
    return query.toLowerCase() !== originalKey && query.split(' ').length < wordCount;
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseIsThisCompany(text, phrase) {
  const source = String(text || '');
  const needle = String(phrase || '').trim();

  if (!needle) {
    return false;
  }

  const pattern = new RegExp(
    `(?:^|[^a-z0-9])${escapeRegExp(needle).replace(/\\s+/g, '\\s+')}(?=$|[^a-z0-9])`,
    'ig'
  );
  let found = pattern.exec(source);

  while (found) {
    const tail = source.slice(found.index + found[0].length);
    const possessive = /^['’]s\b/.test(tail);
    const candyMention = possessive && /\bcandy\b/i.test(source) && !/\bcandy\b/i.test(needle);

    if (!DIFFERENT_ORG.test(tail) && !CANDY_ORG.test(tail) && !candyMention) {
      return true;
    }

    found = pattern.exec(source);
  }

  return false;
}

/**
 * The full company name, or its distinctive alias, as its own organization.
 * "Pearson" does not match "Pearson's Candy Company".
 * Returns the query that matched, or null.
 */
export function mentionsCompanyName(text, company, options = {}) {
  const allowShort = options.allowShort !== false;
  const candidates = Array.isArray(options.queries) ? options.queries : companyQueries(company);
  const queries = candidates.filter((query) => {
    if (allowShort) {
      return true;
    }

    return query.split(' ').length > 1 || query.length >= 6;
  });

  return queries.find((query) => phraseIsThisCompany(text, query)) || null;
}

export function includesPhrase(text, phrase) {
  const escaped = phrase
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');

  return new RegExp(
    `(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`,
    'i'
  ).test(text);
}
