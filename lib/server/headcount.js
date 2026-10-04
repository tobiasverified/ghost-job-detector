import * as cheerio from 'cheerio';
import { companyQueries, mentionsCompanyName } from './companies.js';
import { findCompanyWorkforce, parseEmployeeSnippet } from './workforce.js';

export const HEADCOUNT_SOURCES = new Set(['crunchbase', 'website', 'search', 'apollo']);
const CHAIN_BUDGET_MS = 8000;
const ATTEMPT_TIMEOUT_MS = 30000;
const EMPLOYEE_ENUMS = {
  c_00001_00010: [1, 10],
  c_00011_00050: [11, 50],
  c_00051_00100: [51, 100],
  c_00101_00250: [101, 250],
  c_00251_00500: [251, 500],
  c_00501_01000: [501, 1000],
  c_01001_05000: [1001, 5000],
  c_05001_10000: [5001, 10000],
  c_10001_max: [10001, null]
};

export class QuotaError extends Error {
  constructor(source, status) {
    super(`${source} quota exhausted (${status})`);
    this.quota = true;
    this.source = source;
    this.status = status;
  }
}

function envValue(deps, name) {
  return deps.env?.[name] || '';
}

function rangeFromNumbers(min, max) {
  const minimum = Number(min);
  const maximum = max == null ? null : Number(max);

  if (!Number.isFinite(minimum) || minimum <= 0) {
    return null;
  }

  const estimate = Number.isFinite(maximum) && maximum >= minimum
    ? Math.round((minimum + maximum) / 2)
    : minimum;
  const label = Number.isFinite(maximum)
    ? `${minimum.toLocaleString('en-US')}-${maximum.toLocaleString('en-US')} employees`
    : `${minimum.toLocaleString('en-US')}+ employees`;

  return {
    employees: estimate,
    employeeMin: minimum,
    employeeMax: Number.isFinite(maximum) ? maximum : null,
    employeeLabel: label
  };
}

export function rangeFromEnum(value) {
  const band = EMPLOYEE_ENUMS[String(value || '')];

  if (!band) {
    return null;
  }

  return rangeFromNumbers(band[0], band[1]);
}

function headcountResult(source, parsed, extra = {}) {
  if (!parsed?.employees) {
    return null;
  }

  return {
    available: true,
    unavailable: false,
    employees: parsed.employees,
    employeeMin: parsed.employeeMin ?? parsed.min ?? null,
    employeeMax: parsed.employeeMax ?? parsed.max ?? null,
    employeeLabel: parsed.employeeLabel || parsed.label,
    employeeSource: source,
    score: 0,
    openRoles: null,
    ratio: null,
    ...extra
  };
}

function fromSnippet(source, parsed, extra) {
  if (!parsed) {
    return null;
  }

  return headcountResult(source, {
    employees: parsed.estimate,
    employeeMin: parsed.min,
    employeeMax: parsed.max,
    employeeLabel: parsed.label
  }, extra);
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function lookupCrunchbase(company, deps = {}) {
  const key = envValue(deps, 'CRUNCHBASE_API_KEY');

  if (!key || typeof deps.fetch !== 'function') {
    return null;
  }

  const fetchImpl = deps.fetch;
  const autocomplete = await fetchImpl(
    `https://api.crunchbase.com/api/v4/autocompletes?query=${encodeURIComponent(company)}&collection_ids=organizations&limit=5`,
    { headers: { 'X-Cb-User-Key': key }, signal: AbortSignal.timeout(Math.min(deps.timeoutMs || 2500, ATTEMPT_TIMEOUT_MS)) }
  );

  if (autocomplete.status === 402 || autocomplete.status === 403 || autocomplete.status === 429) {
    throw new QuotaError('crunchbase', autocomplete.status);
  }

  if (!autocomplete.ok) {
    return null;
  }

  const matches = (await readJson(autocomplete))?.entities || [];
  const entity = matches.find((item) => mentionsCompanyName(item?.identifier?.value || '', company)) || matches[0];
  const permalink = entity?.identifier?.permalink;

  if (!permalink) {
    return null;
  }

  const details = await fetchImpl(
    `https://api.crunchbase.com/api/v4/entities/organizations/${encodeURIComponent(permalink)}?field_ids=num_employees_enum`,
    { headers: { 'X-Cb-User-Key': key }, signal: AbortSignal.timeout(Math.min(deps.timeoutMs || 2500, ATTEMPT_TIMEOUT_MS)) }
  );

  if (details.status === 402 || details.status === 403 || details.status === 429) {
    throw new QuotaError('crunchbase', details.status);
  }

  if (!details.ok) {
    return null;
  }

  const body = await readJson(details);
  const parsed = rangeFromEnum(body?.properties?.num_employees_enum);

  return headcountResult('crunchbase', parsed, { url: `https://www.crunchbase.com/organization/${permalink}` });
}

export function companySiteUrls(company) {
  const queries = companyQueries(company);
  const token = String(queries.length ? queries[queries.length - 1] : company)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

  if (token.length < 2) {
    return [];
  }

  const hosts = [`www.${token}.com`, `${token}.com`, `careers.${token}.com`, `about.${token}.com`];
  const paths = ['/about', '/about-us', '/team', '/'];
  const urls = [];

  for (const host of hosts) {
    for (const path of paths) {
      urls.push(`https://${host}${path === '/' ? '/' : path}`);
    }
  }

  return urls;
}

export function parseWebsiteEmployees(html, company) {
  const $ = cheerio.load(String(html || ''));
  const bits = [];

  $('h1, h2, h3, p, li').each((_, node) => {
    const text = $(node).text().replace(/\s+/g, ' ').trim();

    if (text.length > 0 && text.length <= 500 && /employees|team size|headcount/i.test(text)) {
      bits.push(text);
    }
  });

  const title = $('title').text();
  const text = `${title} ${bits.join(' ')}`;

  if (company && !mentionsCompanyName(text, company)) {
    return null;
  }

  const normalized = text.replace(
    /(?:team size|headcount)\s*(?:of|:)?\s*(\d[\d,]*)/ig,
    '$1 employees'
  );

  return parseEmployeeSnippet({ title: '', snippet: normalized });
}

export async function lookupWebsite(company, deps = {}) {
  if (typeof deps.fetch !== 'function') {
    return null;
  }

  const deadline = deps.deadline || (Date.now() + 2500);
  let attempts = 0;

  for (const url of companySiteUrls(company)) {
    if (attempts >= 3 || Date.now() >= deadline) {
      break;
    }

    const remaining = Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now());

    if (remaining < 200) {
      break;
    }

    attempts += 1;

    try {
      const response = await deps.fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(remaining)
      });

      if (!response.ok) {
        continue;
      }

      const parsed = parseWebsiteEmployees(await response.text(), company);

      if (parsed) {
        return fromSnippet('website', parsed, { url });
      }
    } catch (error) {
      if (error?.quota) {
        throw error;
      }
    }
  }

  return null;
}

export async function lookupApollo(company, deps = {}) {
  const key = envValue(deps, 'APOLLO_API_KEY');
  const site = companySiteUrls(company).find((url) => url.startsWith('https://') && !url.includes('www.') && url.endsWith('.com/'));

  if (!key || !site || typeof deps.fetch !== 'function') {
    return null;
  }

  const domain = new URL(site).hostname;
  const response = await deps.fetch(
    `https://api.apollo.io/api/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`,
    {
      headers: { 'X-Api-Key': key, accept: 'application/json' },
      signal: AbortSignal.timeout(Math.min(deps.timeoutMs || 2500, ATTEMPT_TIMEOUT_MS))
    }
  );

  if (response.status === 402 || response.status === 403 || response.status === 429) {
    throw new QuotaError('apollo', response.status);
  }

  if (!response.ok) {
    return null;
  }

  const count = Number((await readJson(response))?.organization?.estimated_num_employees);

  if (!Number.isFinite(count) || count <= 0) {
    return null;
  }

  return headcountResult('apollo', {
    employees: count,
    employeeMin: count,
    employeeMax: count,
    employeeLabel: `${count.toLocaleString('en-US')} employees`
  }, { url: `https://${domain}` });
}

function emptyHeadcount(unavailable) {
  return {
    available: false,
    unavailable,
    employees: null,
    employeeMin: null,
    employeeMax: null,
    employeeLabel: null,
    employeeSource: null,
    score: 0,
    openRoles: null,
    ratio: null,
    detail: unavailable
      ? 'Employee lookup did not return a page.'
      : 'Public employee count not found for this company.'
  };
}

export async function findCompanyHeadcount(company, deps = {}) {
  const name = String(company || '').trim();

  if (!name) {
    return emptyHeadcount(false);
  }

  const deadline = Date.now() + (deps.budgetMs || CHAIN_BUDGET_MS);
  const steps = [
    ['crunchbase', lookupCrunchbase],
    ['website', lookupWebsite],
    ['search', async (companyName, stepDeps) => findCompanyWorkforce(companyName, stepDeps)],
    ['apollo', lookupApollo]
  ];
  let sawFailure = false;

  for (const [source, lookup] of steps) {
    const remaining = deadline - Date.now();

    if (remaining < 200) {
      console.info('[GHD] headcount budget spent', { company: name, source });
      break;
    }

    try {
      const result = await lookup(name, { ...deps, deadline, timeoutMs: Math.min(remaining, ATTEMPT_TIMEOUT_MS) });

      if (result?.employees) {
        console.info('[GHD] headcount', {
          company: name,
          source: result.employeeSource || source,
          employees: result.employees,
          min: result.employeeMin ?? null,
          max: result.employeeMax ?? null
        });
        return result.employeeSource ? result : { ...result, employeeSource: source };
      }

      console.info('[GHD] headcount miss', { company: name, source });
    } catch (error) {
      sawFailure = true;
      console.info('[GHD] headcount source skipped', {
        company: name,
        source,
        quota: Boolean(error?.quota),
        status: error?.status || null
      });
    }
  }

  return emptyHeadcount(sawFailure);
}
