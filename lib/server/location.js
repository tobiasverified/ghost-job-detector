const STATE_NAMES = {
  al: 'Alabama',
  ak: 'Alaska',
  az: 'Arizona',
  ar: 'Arkansas',
  ca: 'California',
  co: 'Colorado',
  ct: 'Connecticut',
  de: 'Delaware',
  fl: 'Florida',
  ga: 'Georgia',
  hi: 'Hawaii',
  id: 'Idaho',
  il: 'Illinois',
  in: 'Indiana',
  ia: 'Iowa',
  ks: 'Kansas',
  ky: 'Kentucky',
  la: 'Louisiana',
  me: 'Maine',
  md: 'Maryland',
  ma: 'Massachusetts',
  mi: 'Michigan',
  mn: 'Minnesota',
  ms: 'Mississippi',
  mo: 'Missouri',
  mt: 'Montana',
  ne: 'Nebraska',
  nv: 'Nevada',
  nh: 'New Hampshire',
  nj: 'New Jersey',
  nm: 'New Mexico',
  ny: 'New York',
  nc: 'North Carolina',
  nd: 'North Dakota',
  oh: 'Ohio',
  ok: 'Oklahoma',
  or: 'Oregon',
  pa: 'Pennsylvania',
  ri: 'Rhode Island',
  sc: 'South Carolina',
  sd: 'South Dakota',
  tn: 'Tennessee',
  tx: 'Texas',
  ut: 'Utah',
  vt: 'Vermont',
  va: 'Virginia',
  wa: 'Washington',
  wv: 'West Virginia',
  wi: 'Wisconsin',
  wy: 'Wyoming',
  dc: 'District of Columbia'
};

function stripLeadingCompany(value, company) {
  const text = String(value || '')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const name = String(company || '')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text || !name) {
    return text;
  }

  // Keep this aligned with stripLeadingCompany in lib/job-page.js. A hyphen
  // inside the company name, as in T-Mobile, is not a separator.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^${escaped}(?![A-Za-z0-9])[\\s·•|–—-]*`, 'i'), '').trim();
}

export function normalizeJobLocation(value, company) {
  const raw = stripLeadingCompany(String(value || '').replace(/\s+/g, ' ').trim(), company);

  if (!raw) {
    return { raw: '', normalized: '' };
  }

  const remote = /\bremote\b/i.test(raw);
  let text = raw
    .replace(/\b(greater|metro|metropolitan|metroplex)\b/gi, ' ')
    .replace(/\barea\b/gi, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^,|,$/g, '')
    .trim();

  text = text.replace(/\b([A-Za-z]{2})\b/g, (token) => STATE_NAMES[token.toLowerCase()] || token);

  if (remote && !/\bremote\b/i.test(text)) {
    text = `Remote ${text}`.trim();
  }

  return {
    raw,
    normalized: text.replace(/\s+/g, ' ').trim()
  };
}

export function locationCity(value) {
  const normalized = normalizeJobLocation(value).normalized.toLowerCase();
  const withoutRemote = normalized.replace(/\bremote\b/g, ' ').replace(/\s+/g, ' ').trim();
  return withoutRemote.split(',')[0].trim();
}

function hasPhrase(text, phrase) {
  const escaped = String(phrase || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z])${escaped}(?:$|[^a-z])`, 'i').test(text);
}

export function locationsMatch(left, right) {
  const leftNorm = normalizeJobLocation(left).normalized.toLowerCase();
  const rightNorm = normalizeJobLocation(right).normalized.toLowerCase();

  if (!leftNorm || !rightNorm) {
    return false;
  }

  if (leftNorm === rightNorm) {
    return true;
  }

  const leftCity = locationCity(left);
  const rightCity = locationCity(right);

  if (leftCity && rightCity && leftCity === rightCity) {
    return true;
  }

  if (leftCity.length >= 3 && hasPhrase(rightNorm, leftCity)) {
    return true;
  }

  if (rightCity.length >= 3 && rightCity.split(' ').length <= 3 && hasPhrase(leftNorm, rightCity)) {
    return true;
  }

  const leftRemote = /\bremote\b/.test(leftNorm);
  const rightRemote = /\bremote\b/.test(rightNorm);
  return leftRemote && rightRemote && !leftCity && !rightCity;
}
