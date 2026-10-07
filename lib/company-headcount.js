(function (root, factory) {
  // background.js injects this again into a tab that already has it.
  if (root.__GHD_HEADCOUNT__) {
    return;
  }

  root.__GHD_HEADCOUNT__ = true;
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.GhdHeadcount = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const COMPANY_HEADCOUNT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
  const PAGE_SELECTORS = [
    'a[href*="/people"]',
    '.org-top-card-summary-info-list__info-item',
    '[data-test-id*="company-size"]',
    '[data-test-id*="employees"]',
    '[class*="company-size"]',
    '[class*="employee-count"]',
    '.org-about-company-module__company-size-definition'
  ];

  // Trailing legal-form words. "TKO Group Holdings" and the LinkedIn slug
  // "tkogroup" are the same employer; the slug is not a separate identity.
  const TRAILING_LEGAL_SUFFIXES = new Set([
    'holdings', 'holding', 'inc', 'incorporated', 'corp', 'corporation',
    'llc', 'ltd', 'limited', 'plc', 'co', 'company', 'lp', 'llp',
    'sa', 'ag', 'gmbh', 'nv'
  ]);

  function storageKey(slug) {
    const key = normalizeSlug(slug);
    return key ? `ghd_company_headcount_${key}` : '';
  }

  function companyWords(company) {
    return String(company || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }

  // Compact form of the resolved company name. This is the shared identity key:
  // a LinkedIn company page and a Workday posting that resolve to the same
  // name write and read the same slot. background.js does not see this cache.
  function identitySlug(company) {
    const compact = companyWords(company).join('');
    return compact.length >= 4 ? compact : '';
  }

  function normalizeSlug(value) {
    let text = String(value || '').trim().toLowerCase();

    try {
      text = decodeURIComponent(text);
    } catch {
      // Keep the raw slug when it is not encoded.
    }

    return text.replace(/[^a-z0-9-]+/g, '').replace(/^-+|-+$/g, '');
  }

  function slugFromUrl(rawUrl) {
    const match = String(rawUrl || '').match(/linkedin\.com\/company\/([^/?#]+)/i);
    return match ? normalizeSlug(match[1]) : '';
  }

  function numeric(value) {
    const count = Number(String(value || '').replace(/,/g, ''));
    return Number.isFinite(count) && count > 0 ? Math.round(count) : null;
  }

  function parseEmployeeCount(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();

    if (!text) {
      return null;
    }

    const listed = text.match(/(?:view|discover)\s+all\s+(\d[\d,]*)\s+employees?\b/i);
    const listedCount = numeric(listed?.[1]);

    if (listedCount) {
      return listedCount;
    }

    const range = text.match(/(\d[\d,]*)\s*(?:-|–|to)\s*(\d[\d,]*)\s*employees?\b/i);

    if (range) {
      const minimum = numeric(range[1]);
      const maximum = numeric(range[2]);

      if (minimum && maximum && maximum >= minimum) {
        return Math.round((minimum + maximum) / 2);
      }
    }

    const plus = text.match(/(\d[\d,]*)\s*\+\s*employees?\b/i);
    const plusCount = numeric(plus?.[1]);

    if (plusCount) {
      return plusCount;
    }

    const exact = text.match(/(\d[\d,]*)\s+employees?\b/i);
    return numeric(exact?.[1]);
  }

  function readPageEmployees(root) {
    if (!root?.querySelectorAll) {
      return null;
    }

    for (const selector of PAGE_SELECTORS) {
      for (const node of root.querySelectorAll(selector)) {
        const count = parseEmployeeCount(node.textContent || node.innerText || '');

        if (count) {
          return count;
        }
      }
    }

    for (const term of root.querySelectorAll('dt')) {
      if (!/employees|company size/i.test(term.textContent || '')) {
        continue;
      }

      const count = parseEmployeeCount(
        [term.textContent, term.nextElementSibling?.textContent].filter(Boolean).join(' ')
      );

      if (count) {
        return count;
      }
    }

    return null;
  }

  function lookupSlugs(slug, company) {
    const found = [];
    const push = (value) => {
      const key = normalizeSlug(value);

      if (key && !found.includes(key)) {
        found.push(key);
      }
    };

    // Resolved name first, then a capture that was stored under the LinkedIn
    // slug before this identity key existed. Dropping only a trailing legal
    // suffix ("Holdings") turns "TKO Group Holdings" into "tkogroup".
    push(identitySlug(company));

    const hyphenated = String(company || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (hyphenated.length >= 4) {
      push(hyphenated);
    }

    const words = companyWords(company);

    while (words.length > 2 && TRAILING_LEGAL_SUFFIXES.has(words[words.length - 1])) {
      words.pop();
      push(words.join(''));
      push(words.join('-'));
    }

    push(slug);
    return found;
  }

  function pageCompanyName(root) {
    const raw = root?.querySelector?.('h1')?.textContent
      || root?.querySelector?.('meta[property="og:title"]')?.getAttribute?.('content')
      || root?.title
      || '';
    return String(raw).split('|')[0].replace(/\s+/g, ' ').trim();
  }

  function captureRecord(slug, company, employees, capturedAt) {
    return {
      slug: normalizeSlug(slug),
      company: String(company || '').replace(/\s+/g, ' ').trim(),
      employees,
      capturedAt
    };
  }

  function captureKeys(slug, company) {
    const keys = [storageKey(slug), storageKey(identitySlug(company))];
    return keys.filter((key, index) => key && keys.indexOf(key) === index);
  }

  function freshHeadcount(stored, slugs, now = Date.now()) {
    const time = Number(now);

    for (const slug of slugs || []) {
      const key = storageKey(slug);
      const record = stored?.[key] || stored?.[slug];
      const employees = Number(record?.employees);
      const capturedAt = Number(record?.capturedAt);

      if (!Number.isFinite(employees) || employees <= 0 || !Number.isFinite(capturedAt)) {
        continue;
      }

      if (time - capturedAt > COMPANY_HEADCOUNT_TTL_MS || capturedAt > time + 5 * 60 * 1000) {
        continue;
      }

      return {
        slug: normalizeSlug(record.slug || slug),
        employees: Math.round(employees),
        capturedAt
      };
    }

    return null;
  }

  return {
    COMPANY_HEADCOUNT_TTL_MS,
    storageKey,
    normalizeSlug,
    identitySlug,
    slugFromUrl,
    parseEmployeeCount,
    readPageEmployees,
    lookupSlugs,
    pageCompanyName,
    captureRecord,
    captureKeys,
    freshHeadcount
  };
});
