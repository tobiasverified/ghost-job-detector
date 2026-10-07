import { cacheGet, cacheSet } from './cache.js';
import { companyCacheKey, companyQueries, mentionsCompanyName } from './companies.js';

const LINKEDIN_LEGAL_TOKENS = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co',
  'company', 'plc', 'lp', 'llp', 'pllc', 'pc', 'the'
]);
const LINKEDIN_TRAILING_TOKENS = new Set([
  'residential', 'consulting', 'education', 'educational', 'publishing',
  'publisher', 'learning', 'university', 'college', 'health', 'healthcare',
  'medical', 'hospital', 'staffing', 'operations', 'holdings', 'holding',
  'group', 'partners', 'partner', 'advisors', 'advisor', 'solutions',
  'services', 'service', 'technologies', 'technology', 'international', 'global'
]);

export const WORKFORCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const WORKFORCE_SOURCE = 'linkedin';

export function linkedinCompanySlugs(name) {
  const collapsed = String(name || '')
    .replace(/\b([A-Za-z])\.(?=\s*[A-Za-z]\b)/g, '$1')
    .replace(/\./g, ' ');
  const tokens = collapsed
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token && !LINKEDIN_LEGAL_TOKENS.has(token));

  if (!tokens.length) {
    return [];
  }

  const slugs = [];
  const push = (parts) => {
    const slug = parts.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '');

    if (slug && !slugs.includes(slug)) {
      slugs.push(slug);
    }
  };

  push(tokens);
  const stripped = tokens.slice();

  while (stripped.length > 1 && LINKEDIN_TRAILING_TOKENS.has(stripped[stripped.length - 1])) {
    stripped.pop();
    push(stripped);
  }

  return slugs.slice(0, 3);
}

// v2 drops v1 entries that could be read from company-page HTML a client sent.
export function workforceCacheKey(company) {
  return `workforce:v2:${companyCacheKey(company)}`;
}

export function visibleCompanyText(html) {
  const source = String(html || '');
  const structured = [...source.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .join('\n');
  const text = source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  return `${structured}\n${text}`.trim();
}

function numeric(value) {
  const count = Number(String(value || '').replace(/,/g, ''));
  return Number.isFinite(count) ? count : null;
}

export function parseEmployeeCount(text) {
  const source = String(text || '');
  const listed = source.match(/(?:view|discover)\s+all\s+(\d[\d,]*)\s+employees?\b/i);

  if (listed) {
    const employees = numeric(listed[1]);

    if (employees > 0) {
      return { employees, label: listed[1], kind: 'exact' };
    }
  }

  const range = source.match(/(\d[\d,]*)\s*(?:-|–|to)\s*(\d[\d,]*)\s*employees?\b/i);

  if (range) {
    const minimum = numeric(range[1]);
    const maximum = numeric(range[2]);

    if (minimum > 0 && maximum >= minimum) {
      return {
        employees: Math.round((minimum + maximum) / 2),
        label: `${range[1]}-${range[2]}`,
        kind: 'range'
      };
    }
  }

  const minimumCount = source.match(/(\d[\d,]*)\s*\+\s*employees?\b/i);

  if (minimumCount) {
    const employees = numeric(minimumCount[1]);

    if (employees > 0) {
      return { employees, label: `${minimumCount[1]}+`, kind: 'minimum' };
    }
  }

  const exact = source.match(/(\d[\d,]*)\s+employees?\b/i);

  if (exact) {
    const employees = numeric(exact[1]);

    if (employees > 0) {
      return { employees, label: exact[1], kind: 'exact' };
    }
  }

  const followers = source.match(/(\d[\d,]*)\s+followers?\b/i);

  if (followers) {
    const employees = numeric(followers[1]);

    if (employees > 0) {
      return { employees, label: followers[1], kind: 'followers' };
    }
  }

  return null;
}

export function parseOpenRoles(text, company = '') {
  const source = String(text || '');
  for (const query of companyQueries(company)) {
    const phrase = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const named = source.match(new RegExp(
      `(?:^|[^a-z0-9])${phrase}[^.]{0,48}?(\\d[\\d,]*)\\s+open\\s+jobs?`,
      'i'
    ));
    const count = numeric(named?.[1]);

    if (count > 0) {
      return count;
    }
  }

  const patterns = [
    /\bsee\s+all\s+(\d[\d,]*)\s+jobs?\b/i,
    /(\d[\d,]*)\s*\+?\s+job\s+openings?\b/i,
    /"jobCount"\s*:\s*(\d+)/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    const count = numeric(match?.[1]);

    if (count > 0) {
      return count;
    }
  }

  return null;
}

function formatCount(value) {
  return Math.round(value).toLocaleString('en-US');
}

const LOWER_BOUND_TOOLTIP = 'Employee count is a lower-bound estimate from an open-ended size bucket, so this ratio is less precise than an exact headcount or a closed range. Company hiring for 3+ positions per employee may have inflated postings';

function formatRatio(ratio) {
  return String(Math.round(ratio * 100) / 100);
}

// Keep this curve identical to pointsForHiringRatio in lib/heuristics.js.
// Full credit stays at 3 or more open roles per employee. From 2 up to 3 the
// score climbs from 20 to 25, above the old flat 17. From 1.5 up to 2 it
// climbs from 0 to 20, so a ratio just under 2 is no longer worth nothing.
function pointsForHiringRatio(ratio) {
  if (ratio >= 3) {
    return 25;
  }

  if (ratio >= 2) {
    return Math.round(20 + (ratio - 2) * 5);
  }

  if (ratio >= 1.5) {
    return Math.round((ratio - 1.5) * 40);
  }

  return 0;
}

export function scoreHiringRatio({ employees, openRoles, employeeLabel, lowerBound = false } = {}) {
  const staff = Number(employees);
  const roles = Number(openRoles);

  if (!Number.isFinite(staff) || staff <= 0) {
    return {
      available: false,
      score: 0,
      employees: null,
      openRoles: null,
      ratio: null,
      label: 'Unavailable',
      detail: 'LinkedIn company page did not expose both employee count and open roles.',
      tooltip: 'Company hiring for 3+ positions per employee may have inflated postings',
      source: WORKFORCE_SOURCE
    };
  }

  if (!Number.isFinite(roles) || roles <= 0) {
    const staffLabel = lowerBound
      ? String(employeeLabel || `${formatCount(staff)}+`).replace(/\s*employees?$/i, '')
      : formatCount(staff);

    return {
      available: false,
      score: 0,
      employees: staff,
      openRoles: null,
      ratio: null,
      lowerBound: Boolean(lowerBound),
      label: `${staffLabel} employees · open roles unknown`,
      detail: '',
      tooltip: lowerBound
        ? LOWER_BOUND_TOOLTIP
        : 'Company hiring for 3+ positions per employee may have inflated postings',
      source: WORKFORCE_SOURCE
    };
  }

  const ratio = Math.round((roles / staff) * 100) / 100;
  const score = pointsForHiringRatio(ratio);

  const staffLabel = lowerBound
    ? String(employeeLabel || `${formatCount(staff)}+`).replace(/\s*employees?$/i, '')
    : formatCount(staff);
  const tooltip = lowerBound
    ? LOWER_BOUND_TOOLTIP
    : 'Company hiring for 3+ positions per employee may have inflated postings';

  return {
    available: true,
    score,
    employees: staff,
    openRoles: roles,
    ratio,
    lowerBound: Boolean(lowerBound),
    label: `${staffLabel} employees / ${formatCount(roles)} open roles = ${formatRatio(ratio)}:1 ratio`,
    detail: tooltip,
    tooltip,
    source: WORKFORCE_SOURCE
  };
}

export function readWorkforce(company, aboutHtml, jobsHtml = '') {
  const aboutText = visibleCompanyText(aboutHtml);
  const jobsText = visibleCompanyText(jobsHtml);
  const combined = `${aboutText}\n${jobsText}`.trim();

  if (!combined || !mentionsCompanyName(combined.slice(0, 8000), company)) {
    return scoreHiringRatio({});
  }

  const employees = parseEmployeeCount(aboutText) || parseEmployeeCount(jobsText);
  const openRoles = parseOpenRoles(`${jobsText}\n${aboutText}`, company);

  return scoreHiringRatio({
    employees: employees?.employees,
    openRoles
  });
}

export async function fetchLinkedInCompany(slug) {
  const response = await fetch(`https://www.linkedin.com/company/${slug}/`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'text/html'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(4000)
  });

  if (!response.ok) {
    throw new Error(`LinkedIn company page failed (${response.status})`);
  }

  return response.text();
}

export async function detectWorkforce(company, deps = {}) {
  const now = deps.now || new Date();
  const key = workforceCacheKey(company);
  const cached = deps.cache ? await cacheGet(deps.cache, key, now) : null;

  if (cached?.available) {
    return { ...cached, cached: true };
  }

  const about = deps.clientHtml?.company || '';
  const jobs = deps.clientHtml?.companyJobs || '';
  let result = readWorkforce(company, about, jobs);
  const clientTried = Boolean(about || jobs);

  if (!result.available && !clientTried && typeof deps.fetchCompanyPage === 'function') {
    const fetchPage = deps.fetchCompanyPage;
    const slug = linkedinCompanySlugs(company)[0];

    if (slug) {
      try {
        const html = await fetchPage(slug);
        result = readWorkforce(company, html, '');
        if (result.available) {
          result.url = `https://www.linkedin.com/company/${slug}/`;
        }
      } catch {
        result = scoreHiringRatio({});
      }
    }
  }

  if (result.available) {
    const slug = linkedinCompanySlugs(company)[0];
    result.url = result.url || (slug ? `https://www.linkedin.com/company/${slug}/` : null);
  }

  if (deps.cache && result.available) {
    await cacheSet(deps.cache, key, {
      available: true,
      score: result.score,
      employees: result.employees,
      openRoles: result.openRoles,
      ratio: result.ratio,
      label: result.label,
      detail: result.detail,
      tooltip: result.tooltip,
      source: result.source,
      url: result.url || null
    }, WORKFORCE_TTL_MS, now);
  }

  return { ...result, cached: false };
}

export function parseEmployeeSnippet(result) {
  const text = `${result?.title || ''} ${result?.snippet || ''}`;
  const rangeMatch = text.match(/(\d[\d,]*)\s*(?:-|–|to)\s*(\d[\d,]*)\s*employees?/i);

  if (rangeMatch) {
    const minimum = Number(rangeMatch[1].replace(/,/g, ''));
    const maximum = Number(rangeMatch[2].replace(/,/g, ''));

    if (minimum > 0 && maximum >= minimum) {
      return {
        min: minimum,
        max: maximum,
        estimate: Math.round((minimum + maximum) / 2),
        label: `${rangeMatch[1]}-${rangeMatch[2]} employees`
      };
    }
  }

  const plusMatch = text.match(/(\d[\d,]*)\s*\+\s*employees?/i);

  if (plusMatch) {
    const minimum = Number(plusMatch[1].replace(/,/g, ''));

    if (minimum > 0) {
      return {
        min: minimum,
        max: null,
        estimate: minimum,
        label: `${plusMatch[1]}+ employees`
      };
    }
  }

  const singleMatch = text.match(/(\d[\d,]*)\s*employees?/i);

  if (singleMatch) {
    const count = Number(singleMatch[1].replace(/,/g, ''));

    if (count > 0) {
      return {
        min: count,
        max: count,
        estimate: count,
        label: `${count} employees`
      };
    }
  }

  return null;
}

function workforceRank(result) {
  let rank = 0;
  let host = '';

  try {
    host = new URL(result.url).hostname.toLowerCase();
  } catch {
    host = '';
  }

  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    rank += 8;
  }

  return rank;
}

export function pickWorkforce(results, company) {
  const ranked = [];

  for (const result of results || []) {
    const text = `${result?.title || ''} ${result?.snippet || ''}`;

    if (company && !mentionsCompanyName(text, company)) {
      continue;
    }

    const parsed = parseEmployeeSnippet(result);

    if (!parsed) {
      continue;
    }

    ranked.push({ result, parsed });
  }

  ranked.sort((left, right) => workforceRank(right.result) - workforceRank(left.result));
  return ranked[0] || null;
}

function emptyWorkforce(unavailable) {
  return {
    available: false,
    unavailable,
    employees: null,
    employeeSource: null,
    score: 0,
    openRoles: null,
    ratio: null,
    detail: unavailable
      ? 'Employee search did not return a page.'
      : 'Public employee count not found for this company.'
  };
}

export async function findCompanyWorkforce(company, deps = {}) {
  const name = String(company || '').replace(/["<>]/g, '').trim();

  if (!name) {
    return emptyWorkforce(false);
  }

  const queries = companyQueries(name);
  const searchNames = queries.length ? [...queries].reverse() : [name];
  let sawResult = false;
  let sawFailure = false;

  for (const term of searchNames) {
    try {
      const linkedIn = await deps.webSearch(`"${term}" number of employees site:linkedin.com`);
      sawResult = true;
      const picked = pickWorkforce(linkedIn, name);

      if (picked) {
        return {
          available: true,
          unavailable: false,
          employees: picked.parsed.estimate,
          employeeMin: picked.parsed.min,
          employeeMax: picked.parsed.max,
          employeeLabel: picked.parsed.label,
          employeeSource: 'search',
          score: 0,
          openRoles: null,
          ratio: null,
          url: picked.result.url || null
        };
      }
    } catch {
      sawFailure = true;
    }
  }

  for (const term of searchNames) {
    try {
      const fallback = await deps.webSearch(`"${term}" employees company size`);
      sawResult = true;
      const picked = pickWorkforce(fallback, name);

      if (picked) {
        return {
          available: true,
          unavailable: false,
          employees: picked.parsed.estimate,
          employeeMin: picked.parsed.min,
          employeeMax: picked.parsed.max,
          employeeLabel: picked.parsed.label,
          employeeSource: 'search',
          score: 0,
          openRoles: null,
          ratio: null,
          url: picked.result.url || null
        };
      }
    } catch {
      sawFailure = true;
    }
  }

  return emptyWorkforce(sawFailure && !sawResult);
}
