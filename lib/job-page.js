(function (root, factory) {
  // background.js injects this again into a tab that already has it.
  if (root.__GHD_PAGE__) {
    return;
  }

  root.__GHD_PAGE__ = true;
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.GhdPage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function parseJobPage(rawUrl) {
    let url;

    try {
      url = new URL(rawUrl);
    } catch {
      return { supported: false, platform: null, kind: null, jobId: null };
    }

    const host = url.hostname.toLowerCase();

    if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
      const viewMatch = url.pathname.match(/\/jobs\/view\/(?:[^/]+-)?(\d+)/);

      if (viewMatch) {
        return {
          supported: true,
          platform: 'linkedin',
          kind: 'detail',
          jobId: viewMatch[1]
        };
      }

      const companyMatch = url.pathname.match(/\/company\/([^/?#]+)/i);

      if (companyMatch) {
        return {
          supported: true,
          platform: 'linkedin',
          kind: 'company',
          jobId: null,
          slug: companyMatch[1]
        };
      }

      if (/\/jobs\/search(?:-results)?(?:\/|$)/.test(url.pathname)) {
        return {
          supported: true,
          platform: 'linkedin',
          kind: 'search',
          jobId: url.searchParams.get('currentJobId')
        };
      }

      return {
        supported: false,
        platform: 'linkedin',
        kind: 'other',
        jobId: null
      };
    }

    if (host.endsWith('.myworkdayjobs.com')) {
      return {
        supported: true,
        platform: 'workday',
        kind: /\/(?:job|details)\//.test(url.pathname) ? 'detail' : 'list',
        jobId: null
      };
    }

    return { supported: false, platform: null, kind: null, jobId: null };
  }

  function compactCompany(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function slugMatchesCompany(slug, company) {
    const left = compactCompany(slug);
    const right = compactCompany(company);

    if (left.length < 3 || right.length < 3) {
      return false;
    }

    return left === right || right.startsWith(left) || left.startsWith(right);
  }

  // Keep this aligned with linkedInOpenJobsScoped in lib/server/open-jobs.js.
  // A keyword search count is only the rendered hits for that term.
  function linkedInOpenJobsScoped(pageUrl, options = {}) {
    let url;

    try {
      url = new URL(String(pageUrl || ''));
    } catch {
      return false;
    }

    const host = url.hostname.toLowerCase();

    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) {
      return false;
    }

    let path = url.pathname;

    try {
      path = decodeURIComponent(path);
    } catch {
      // Keep the raw path when it is not encoded.
    }

    const jobs = path.match(/\/jobs\/([^/]+)-jobs(?:-worldwide)?\/?$/i);
    const companyBoard = path.match(/\/company\/([^/]+)\/jobs\/?$/i);
    const slug = (jobs || companyBoard)?.[1] || '';

    if (slug && slugMatchesCompany(slug, options.company)) {
      return true;
    }

    const filters = String(url.searchParams.get('f_C') || '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => /^\d+$/.test(part));
    const companyId = String(options.companyId || '').trim();

    if (companyId && filters.includes(companyId)) {
      return true;
    }

    if (String(url.searchParams.get('keywords') || '').trim()) {
      return false;
    }

    return options.allResultsMatch === true;
  }

  function scriptFilesFor(page) {
    if (!page?.supported) {
      return null;
    }

    if (page.platform === 'linkedin' && page.kind === 'company') {
      return ['lib/company-headcount.js', 'content/linkedin-company.js'];
    }

    if (page.platform === 'linkedin') {
      return ['lib/company-headcount.js', 'lib/job-page.js', 'lib/heuristics.js', 'lib/widget.js', 'content.js'];
    }

    if (page.platform === 'workday') {
      return ['lib/company-headcount.js', 'lib/job-page.js', 'lib/heuristics.js', 'lib/widget.js', 'content/workday.js'];
    }

    return null;
  }

  function duckDuckGoUrl(query) {
    return `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  }

  function countWorkdayOpenings(entries) {
    const ids = new Set();

    for (const entry of entries || []) {
      const href = String(entry?.href || '').trim();
      const text = String(entry?.text || '').replace(/\s+/g, ' ').trim();
      let key = '';

      if (href) {
        try {
          key = new URL(href, 'https://example.myworkdayjobs.com').pathname;
        } catch {
          key = href;
        }
      } else {
        key = text;
      }

      if (key) {
        ids.add(key);
      }
    }

    return ids.size || null;
  }

  function companyFromPrimary(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();

    if (!text) {
      return '';
    }

    return text.split(/\s*[·•|]\s*/)[0].trim();
  }

  function isSafeHttpUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }

  const DEFAULT_API_BASE = 'https://ghost-job-detector-nine.vercel.app';

  const STATE_NAMES = {
    al: 'Alabama', ak: 'Alaska', az: 'Arizona', ar: 'Arkansas', ca: 'California',
    co: 'Colorado', ct: 'Connecticut', de: 'Delaware', fl: 'Florida', ga: 'Georgia',
    hi: 'Hawaii', id: 'Idaho', il: 'Illinois', in: 'Indiana', ia: 'Iowa',
    ks: 'Kansas', ky: 'Kentucky', la: 'Louisiana', me: 'Maine', md: 'Maryland',
    ma: 'Massachusetts', mi: 'Michigan', mn: 'Minnesota', ms: 'Mississippi',
    mo: 'Missouri', mt: 'Montana', ne: 'Nebraska', nv: 'Nevada', nh: 'New Hampshire',
    nj: 'New Jersey', nm: 'New Mexico', ny: 'New York', nc: 'North Carolina',
    nd: 'North Dakota', oh: 'Ohio', ok: 'Oklahoma', or: 'Oregon', pa: 'Pennsylvania',
    ri: 'Rhode Island', sc: 'South Carolina', sd: 'South Dakota', tn: 'Tennessee',
    tx: 'Texas', ut: 'Utah', vt: 'Vermont', va: 'Virginia', wa: 'Washington',
    wv: 'West Virginia', wi: 'Wisconsin', wy: 'Wyoming', dc: 'District of Columbia'
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

    // A hyphen inside the company name, as in T-Mobile, is not a separator.
    // Only drop the company when it is the leading segment.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`^${escaped}(?![A-Za-z0-9])[\\s·•|–—-]*`, 'i'), '').trim();
  }

  function cityFromLocationLine(line, company) {
    const stripped = stripLeadingCompany(line, company);
    const parts = stripped
      .split(/\s*[·•|]\s*|\s+[-–—]\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const city = parts.find((part) => /,\s*[A-Z]{2}\b/.test(part) || /^(remote|hybrid)$/i.test(part)) || stripped;

    return city
      .split(/\b(?:posted|reposted|applicants?)\b/i)[0]
      .replace(/^[,·•|\s-]+/, '')
      .trim();
  }

  function normalizeJobLocation(value, company) {
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

  function readJobLocation(text, company) {
    const lines = String(text || '').split(/\n+|·|•/);

    for (const line of lines) {
      const cleaned = line.replace(/\s+/g, ' ').trim();

      if (!cleaned || cleaned.length > 80) {
        continue;
      }

      if (/\b(remote|hybrid)\b/i.test(cleaned) && cleaned.length < 48) {
        return cityFromLocationLine(cleaned, company);
      }

      if (/\bgreater\b/i.test(cleaned) && /\barea\b/i.test(cleaned)) {
        return cityFromLocationLine(cleaned, company);
      }

      if (/,\s*[A-Z]{2}\b/.test(cleaned)) {
        return cityFromLocationLine(cleaned, company);
      }
    }

    const match = String(text || '').match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?,\s*[A-Z]{2})\b/);
    return match ? match[1] : '';
  }

  const LINKEDIN_DETAIL_SELECTORS = [
    '.two-pane-serp-page__detail-view',
    '.details-pane__content',
    '.jobs-search__job-details',
    '.jobs-details__main-content',
    '.job-view-layout',
    '.jobs-details',
    '[class*="jobs-search__job-details"]',
    '[class*="job-view-layout"]',
    '[class*="jobs-details__main"]'
  ];

  function isCardNoise(line) {
    return /^(promoted|easy apply|seen|viewed|applied|saved|be an early applicant|actively reviewing applicants)$/i.test(line)
      || /\bago$/i.test(line)
      || /^\d[\d,]*\s+(applicants?|connections?|school alumni|alumni)\b/i.test(line);
  }

  function isLocationLine(line) {
    if (/^(remote|hybrid|on-?site)$/i.test(line)) {
      return true;
    }

    if (line.length < 80 && /\b(remote|hybrid|on-?site|united states|metropolitan|metro)\b/i.test(line)) {
      return true;
    }

    return line.length < 80 && /,\s*[A-Z]{2}\b/.test(line);
  }

  function jobIdFromJobHref(href) {
    try {
      const match = new URL(href, 'https://www.linkedin.com').pathname.match(/\/jobs\/view\/(?:[^/]+-)?(\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function jobIdFromEntityUrn(value) {
    const match = String(value || '').match(/jobPosting:(\d+)/);
    return match ? match[1] : null;
  }

  function parseLinkedInCardText(value) {
    const lines = String(value || '')
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line && !isCardNoise(line));
    const title = lines[0] || '';
    let company = '';

    for (const line of lines.slice(1)) {
      if (isLocationLine(line)) {
        continue;
      }

      company = companyFromPrimary(line);
      break;
    }

    return { title, company };
  }

  function cleanCompanyLabel(value) {
    const text = String(value || '')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text || text.length > 80) {
      return '';
    }

    if (/^(careers?\s*home|careers?|home|jobs?|workday|search(?: for jobs)?|job search)$/i.test(text)) {
      return '';
    }

    if (/^careers?\b/i.test(text) && text.split(' ').length <= 3) {
      return '';
    }

    return text;
  }

  const LEGAL_NAME_TOKENS = new Set([
    'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co',
    'company', 'group', 'holdings', 'holding', 'services', 'service', 'plc',
    'the', 'and', 'of'
  ]);

  function isInternalDivisionName(value) {
    const tokens = String(value || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((token) => token && !LEGAL_NAME_TOKENS.has(token));

    return tokens.length >= 3;
  }

  function workdaySiteName(siteId) {
    return String(siteId || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\b(careers?|jobs?|external|site)\b/ig, ' ');
  }

  function workdayHostFragment(hostname) {
    const hostMatch = String(hostname || '').match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/i);
    return hostMatch ? hostMatch[1].replace(/[-_]+/g, ' ').trim() : '';
  }

  function isWeakAcronym(value) {
    return /^[A-Z]{2,3}$/.test(String(value || '').trim());
  }

  function isNormalCompanyName(value) {
    const text = cleanCompanyLabel(value);

    if (!text || isWeakAcronym(text) || /career/i.test(text)) {
      return false;
    }

    if (!/\s/.test(text) && text === text.toLowerCase()) {
      return false;
    }

    return text.length > 3;
  }

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
          // The left side of "UHealth-University" is a boundary. Stop there
          // without keeping it, so "University of Miami" can stand alone.
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
        const after = text.slice(match.index + match[0].length);
        const parenthetical = after
          .slice(0, 48)
          .match(/^\s*\(\s*["'“”]?([A-Z][A-Za-z0-9.&'-]{2,})["'“”]?\s*\)/);

        for (const phrase of phrases) {
          found.push(withLegalSuffix(phrase, after));
        }

        if (parenthetical) {
          found.push(parenthetical[1]);
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

  function aliasCorroboratesHost(alias, hostFragment) {
    const left = compactIdentity(alias);
    const host = compactIdentity(hostFragment);
    return Boolean(left && host && (left === host || left.includes(host)));
  }

  function identityNames(entity, searchHit) {
    const names = [];
    const label = entity?.labels?.en?.value || searchHit?.label;

    if (label) {
      names.push(label);
    }

    for (const alias of entity?.aliases?.en || []) {
      if (alias?.value) {
        names.push(alias.value);
      }
    }

    return names;
  }

  const IDENTITY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

  function identityCacheKey(hostname) {
    return `ghd_company_identity_${String(hostname || '').toLowerCase()}`;
  }

  function identityNow(deps) {
    const now = deps?.now ? new Date(deps.now) : new Date();
    return Number.isNaN(now.getTime()) ? Date.now() : now.getTime();
  }

  async function readIdentityCache(hostname, deps) {
    const key = identityCacheKey(hostname);
    let stored = null;

    if (deps?.cache?.get) {
      stored = await deps.cache.get(key);
    } else {
      const storage = deps?.storage || globalThis.chrome?.storage?.local;

      if (storage?.get) {
        stored = await new Promise((resolve) => {
          const result = storage.get(key, (items) => resolve(items?.[key] || null));

          if (result && typeof result.then === 'function') {
            result.then((items) => resolve(items?.[key] || null)).catch(() => resolve(null));
          }
        });
      }
    }

    if (!stored?.company || !stored.storedAt) {
      return '';
    }

    if (identityNow(deps) - stored.storedAt > IDENTITY_TTL_MS) {
      return '';
    }

    return stored.company;
  }

  async function writeIdentityCache(hostname, company, deps) {
    const key = identityCacheKey(hostname);
    const value = { company, storedAt: identityNow(deps) };

    if (deps?.cache?.set) {
      await deps.cache.set(key, value);
      return;
    }

    const storage = deps?.storage || globalThis.chrome?.storage?.local;

    if (storage?.set) {
      await storage.set({ [key]: value });
    }
  }

  function requestOptions() {
    const options = { headers: { Accept: 'application/json' } };

    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      options.signal = AbortSignal.timeout(8000);
    }

    return options;
  }

  async function wikidataSearch(candidate, deps) {
    const url = new URL('https://www.wikidata.org/w/api.php');
    url.searchParams.set('action', 'wbsearchentities');
    url.searchParams.set('search', candidate);
    url.searchParams.set('language', 'en');
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '5');
    url.searchParams.set('origin', '*');
    const response = await deps.fetch(url, requestOptions());

    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    return Array.isArray(payload?.search) ? payload.search : [];
  }

  async function wikidataEntity(id, deps) {
    const url = new URL('https://www.wikidata.org/w/api.php');
    url.searchParams.set('action', 'wbgetentities');
    url.searchParams.set('ids', id);
    url.searchParams.set('props', 'labels|aliases');
    url.searchParams.set('languages', 'en');
    url.searchParams.set('format', 'json');
    url.searchParams.set('origin', '*');
    const response = await deps.fetch(url, requestOptions());

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
    const cleaned = cleanCompanyLabel(String(organization || '').replace(/^\d+\s+/, ''));

    if (!cleaned || !/\s/.test(cleaned) || cleaned.toLowerCase() === String(siteWord || '').trim().toLowerCase()) {
      return '';
    }

    return containsSiteWord(cleaned, siteWord) ? cleaned : '';
  }

  // Full-description phrases first, then the JSON-LD operator. Every candidate
  // has to contain the site word, so a partner or funder named in the body is dropped.
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

  async function corroborateIdentityCandidates(candidates, hostFragment, hostname, deps) {
    if (!hostFragment || !deps.fetch || !candidates.length) {
      return '';
    }

    for (const candidate of candidates) {
      let hits = [];

      try {
        hits = await wikidataSearch(candidate, deps);
      } catch {
        continue;
      }

      for (const hit of hits) {
        if (!hit?.id) {
          continue;
        }

        let entity = null;

        try {
          entity = await wikidataEntity(hit.id, deps);
        } catch {
          continue;
        }

        const names = identityNames(entity, hit);
        const corroborated = names.some((name) => aliasCorroboratesHost(name, hostFragment));

        if (!corroborated) {
          continue;
        }

        const label = entity?.labels?.en?.value || hit.label || candidate;

        if (hostname) {
          await writeIdentityCache(hostname, label, deps);
        }

        return label;
      }
    }

    return '';
  }

  async function resolveCompanyIdentity(signals, deps = {}) {
    const hostname = String(signals?.hostname || '');
    const cached = hostname ? await readIdentityCache(hostname, deps) : '';

    if (cached) {
      return cached;
    }

    const siteName = cleanCompanyLabel(workdaySiteName(signals?.siteId));
    const hostFragment = workdayHostFragment(hostname);
    const bare = isNormalCompanyName(siteName) ? siteName : '';

    if (bare && !isSingleWordName(bare)) {
      return bare;
    }

    if (bare) {
      const candidates = candidatesForBareName(signals, bare);
      console.info('[GHD] identity bare name candidates', { company: bare, candidates });
      const corroborated = await corroborateIdentityCandidates(candidates, hostFragment, hostname, deps);

      if (corroborated) {
        return corroborated;
      }

      console.info('[GHD] identity kept bare name', bare);
      return bare;
    }

    const heuristic = companyFromWorkdaySignals(signals);
    const candidates = identitySearchCandidates(signals?.description);
    const corroborated = await corroborateIdentityCandidates(candidates, hostFragment, hostname, deps);
    return corroborated || heuristic;
  }

  const IDENTITY_DESCRIPTION_MIN = 200;

  function descriptionReadyForVagueness(description) {
    return String(description || '').trim().length >= IDENTITY_DESCRIPTION_MIN;
  }
  const IDENTITY_RETRY_AT_MS = [1000, 3000, 6000];

  function identityInputReady(description, company) {
    const text = String(description || '').trim();

    if (text.length < IDENTITY_DESCRIPTION_MIN) {
      return false;
    }

    if (!isNormalCompanyName(company) && extractDescriptionCandidates(text).length === 0) {
      return false;
    }

    return true;
  }

  async function resolveCompanyIdentityWhenReady(readSignals, deps = {}) {
    const at = deps.retryAtMs || IDENTITY_RETRY_AT_MS;
    const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const log = deps.log || ((message) => console.info(message));
    const resolveIdentity = deps.resolve || ((signals) => resolveCompanyIdentity(signals, deps));

    let latest = await readSignals();

    if (identityInputReady(latest?.description, latest?.company)) {
      return { ready: true, company: await resolveIdentity(latest) };
    }

    let elapsed = 0;

    for (let index = 0; index < at.length; index += 1) {
      const wait = Math.max(0, at[index] - elapsed);
      elapsed = at[index];

      if (wait) {
        await sleep(wait);
      }

      latest = await readSignals();
      log(`[GHD] company identity retry ${index + 1}/${at.length}, description length: ${String(latest?.description || '').trim().length}`);

      if (identityInputReady(latest?.description, latest?.company)) {
        return { ready: true, company: await resolveIdentity(latest) };
      }
    }

    return { ready: false, company: latest?.company || '' };
  }

  function companyFromWorkdaySignals(signals) {
    const jobTitle = cleanCompanyLabel(signals?.jobTitle) || String(signals?.jobTitle || '').trim();
    const descriptionLead = String(signals?.description || '').split('|')[0];
    const siteName = workdaySiteName(signals?.siteId);
    const pathSegment = String(signals?.pathname || '')
      .split('/')
      .filter(Boolean)
      .map((part) => part.replace(/[_-]+/g, ' '))
      .find((part) => /career|job/i.test(part) && !/^[a-z]{2}\s[a-z]{2}$/i.test(part));
    const hostMatch = String(signals?.hostname || '').match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/i);
    const titleParts = String(signals?.documentTitle || '').split('|').map((part) => part.trim());
    const titleSuffix = titleParts.length > 1 ? titleParts[titleParts.length - 1] : '';
    const organization = String(signals?.organization || '').replace(/^\d+\s+/, '');
    const candidates = [
      descriptionLead,
      siteName,
      hostMatch ? hostMatch[1].replace(/[-_]+/g, ' ') : '',
      isInternalDivisionName(organization) ? '' : organization,
      pathSegment,
      signals?.domCompany,
      titleSuffix
    ];

    for (const candidate of candidates) {
      const cleaned = cleanCompanyLabel(candidate);

      if (!cleaned || cleaned.toLowerCase() === jobTitle.toLowerCase()) {
        continue;
      }

      return cleaned;
    }

    return '';
  }

  function extractLinkedInJobUrls(html) {
    const found = [];
    const seen = new Set();
    const chunks = [String(html || '')];
    const encoded = /uddg=([^&"'\s]+)/gi;
    let encodedMatch = encoded.exec(chunks[0]);

    while (encodedMatch) {
      try {
        chunks.push(decodeURIComponent(encodedMatch[1]));
      } catch {
        // Ignore a broken redirect parameter.
      }

      encodedMatch = encoded.exec(chunks[0]);
    }

    const direct = /https?:\/\/(?:www\.)?linkedin\.com\/jobs\/view\/[a-z0-9%-]+/gi;

    for (const chunk of chunks) {
      let linkMatch = direct.exec(chunk);

      while (linkMatch) {
        const url = linkMatch[0].replace(/&amp;/g, '&').split('?')[0];
        const jobId = (url.match(/(\d{6,})$/) || [])[1];

        if (jobId && !seen.has(jobId)) {
          seen.add(jobId);
          found.push({ url, jobId });
        }

        linkMatch = direct.exec(chunk);
      }

      direct.lastIndex = 0;
    }

    return found;
  }

  // Content scripts fetch with the host page's Origin (e.g. linkedin.com), which the API's
  // CORS policy rejects, so in the extension the request goes through the background worker.
  function extensionSender() {
    const runtime = globalThis.chrome?.runtime;
    return runtime?.id && typeof runtime.sendMessage === 'function'
      ? (message) => runtime.sendMessage(message)
      : null;
  }

  // A fetch for the Wikidata reads in resolveCompanyIdentity that goes through
  // the background. Called from a content script without it, the resolver
  // skips Wikidata and keeps a one-word site name ("Argonne"). The page itself
  // may also forbid the request (Workday sends connect-src 'none').
  function backgroundWikidataFetch(deps = {}) {
    const send = deps.send || extensionSender();

    if (!send) {
      return null;
    }

    return async (url) => {
      const reply = await send({ type: 'WIKIDATA_JSON', url: String(url) });
      return {
        ok: Boolean(reply?.ok),
        status: Number(reply?.status) || 0,
        json: async () => reply?.payload ?? null
      };
    };
  }

  async function requestCompanyIdentity(signals, deps = {}) {
    const rawName = String(signals?.rawName || signals?.company || '').trim();
    const body = {
      rawName,
      description: signals?.description || '',
      hostname: signals?.hostname || '',
      platform: signals?.platform || '',
      slug: signals?.slug || ''
    };
    const send = deps.send || (deps.fetch ? null : extensionSender());

    console.info('[GHD] identity api', {
      rawName,
      slug: body.slug,
      descriptionLength: String(body.description).length,
      via: send ? 'background' : 'fetch'
    });

    try {
      let payload;

      if (send) {
        const reply = await send({ type: 'RESOLVE_COMPANY_IDENTITY', body });

        if (!reply?.ok) {
          console.info('[GHD] identity api failed', reply?.error || 'NO_REPLY');
          return rawName;
        }

        payload = reply.payload;
      } else {
        const fetchImpl = deps.fetch || globalThis.fetch;
        const base = String(deps.apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
        const response = await fetchImpl(`${base}/api/company-identity`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GHD-Client': 'ghost-job-detector'
          },
          body: JSON.stringify(body)
        });

        if (!response?.ok) {
          console.info('[GHD] identity api failed', `API_${response?.status}`);
          return rawName;
        }

        payload = await response.json();
      }

      return String(payload?.company || '').trim() || rawName;
    } catch (error) {
      console.info('[GHD] identity api failed', error?.message || String(error));
      return rawName;
    }
  }

  return {
    DEFAULT_API_BASE,
    isNormalCompanyName,
    backgroundWikidataFetch,
    requestCompanyIdentity,
    parseJobPage,
    linkedInOpenJobsScoped,
    scriptFilesFor,
    duckDuckGoUrl,
    companyFromPrimary,
    isSafeHttpUrl,
    parseLinkedInCardText,
    companyFromWorkdaySignals,
    countWorkdayOpenings,
    extractDescriptionCandidates,
    identityInputReady,
    descriptionReadyForVagueness,
    resolveCompanyIdentity,
    resolveCompanyIdentityWhenReady,
    extractLinkedInJobUrls,
    LINKEDIN_DETAIL_SELECTORS,
    jobIdFromJobHref,
    jobIdFromEntityUrn,
    normalizeJobLocation,
    readJobLocation
  };
});
