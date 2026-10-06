/**
 * Posted pay and the market comparison.
 * The manifest injects this file, and background.js injects it again
 * after a client-side navigation. A second run must not redeclare the
 * top-level constants.
 */
(() => {
  'use strict';

  if (globalThis.__GHD_PAY__) {
    return;
  }

  globalThis.__GHD_PAY__ = true;

  const HOURS_PER_YEAR = 2080;

  function normalizeTitle(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function titlesMatch(requested, returned) {
    const left = normalizeTitle(requested);
    const right = normalizeTitle(returned);
    return Boolean(left) && left === right;
  }

  function thousands(amount) {
    return Math.round(Number(amount) / 1000);
  }

  function formatUsdSpan(min, max) {
    const a = Number(min);
    const b = Number(max);

    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
      return '';
    }

    const lo = Math.min(a, b);
    const hi = Math.max(a, b);

    if (lo >= 1000 && hi >= 1000) {
      const left = thousands(lo);
      const right = thousands(hi);
      return left === right ? `$${left}K` : `$${left}-${right}K`;
    }

    const left = `$${Math.round(lo).toLocaleString('en-US')}`;
    const right = `$${Math.round(hi).toLocaleString('en-US')}`;
    return left === right ? left : `${left}-${right}`;
  }

  function formatHourlySpan(min, max) {
    const lo = Math.round(Math.min(min, max));
    const hi = Math.round(Math.max(min, max));
    return lo === hi ? `$${lo}/hr` : `$${lo}-${hi}/hr`;
  }

  // A posted range, hourly or monthly or annual. Hourly becomes annual at
  // 2,080 hours and monthly at 12, and the comparison uses that base, not
  // bonus or equity. Contract wording and a non-USD currency stay display-only.
  function parsePostedPay(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();

    if (!text) {
      return { ok: false, comparable: false, reason: 'no pay', listed: '' };
    }

    const contract = /\b(contract(?:or)?|c2c|corp(?:\s|-)?to(?:\s|-)?corp|freelance|1099)\b/i.test(text);
    const equity = /\b(equity|rsus?|stock)\b/i.test(text);
    const bonus = /\b(bonus|commission|ote)\b/i.test(text);
    const scaleAmount = /(?:[$£€¥₹]\s?|\b(?:USD|GBP|EUR|CAD|AUD)\s+)\d[\d,]*(?:\.\d+)?(?:\s*[kK])?\s*(?:million|billion|[MB])\b/i;
    const hadScale = scaleAmount.test(text);
    const baseText = text
      .replace(/\s*(?:\+|plus)\s+.*$/i, ' ')
      .replace(/(?:[$£€¥₹]\s?|\b(?:USD|GBP|EUR|CAD|AUD)\s+)\d[\d,]*(?:\.\d+)?(?:\s*[kK])?\s*(?:million|billion|[MB])\b/gi, ' ');
    let currency = 'USD';

    if (/£|\bGBP\b/i.test(text)) {
      currency = 'GBP';
    } else if (/€|\bEUR\b/i.test(text)) {
      currency = 'EUR';
    } else if (/¥|\bJPY\b/i.test(text)) {
      currency = 'JPY';
    } else if (/\bCAD\b|C\$/i.test(text)) {
      currency = 'CAD';
    } else if (/\bAUD\b|A\$/i.test(text)) {
      currency = 'AUD';
    }

    const namedPeriod = /\b(hour|hourly)\b|\/hr\b|\bhr\b/i.test(text)
      ? 'hourly'
      : /\bmonth/i.test(text)
        ? 'monthly'
        : /\bweek/i.test(text)
          ? 'weekly'
          : /\b(year|annual|annually|annum)\b|\/yr\b|\byr\b/i.test(text)
            ? 'annual'
            : '';
    const found = [];
    const pattern = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s*[kK])?/g;
    let match = pattern.exec(baseText);

    while (match) {
      let amount = Number(match[1].replace(/,/g, ''));
      const kilo = Boolean(match[2]);

      if (kilo) {
        amount *= 1000;
      }

      if (Number.isFinite(amount) && amount > 0) {
        found.push({ amount, kilo });
      }

      match = pattern.exec(baseText);
    }

    if (!found.length) {
      return { ok: false, comparable: false, reason: hadScale ? 'scale' : 'no pay', listed: '' };
    }

    const anyKilo = found.some((item) => item.kilo);

    if (anyKilo) {
      found.forEach((item) => {
        if (!item.kilo && item.amount < 1000) {
          item.amount *= 1000;
        }
      });
    }

    const amounts = found.map((item) => item.amount);
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    let period = namedPeriod;

    if (!period) {
      period = Math.max(min, max) >= 1000 ? 'annual' : '';
    }

    let annualMin = null;
    let annualMax = null;

    if (period === 'hourly') {
      annualMin = min * HOURS_PER_YEAR;
      annualMax = max * HOURS_PER_YEAR;
    } else if (period === 'monthly') {
      annualMin = min * 12;
      annualMax = max * 12;
    } else if (period === 'annual') {
      annualMin = min;
      annualMax = max;
    }

    const comparable = currency === 'USD' && !contract && annualMin != null;
    let reason = '';

    if (!comparable) {
      reason = contract ? 'contract' : currency !== 'USD' ? 'currency' : 'period';
    }

    const symbol = { USD: '$', GBP: '£', EUR: '€', JPY: '¥', CAD: 'C$', AUD: 'A$' }[currency] || '$';
    const span = period === 'hourly' && !comparable
      ? formatHourlySpan(min, max)
      : annualMin != null
        ? formatUsdSpan(annualMin, annualMax)
        : formatUsdSpan(min, max);
    const listed = symbol === '$' ? span : span.replace(/\$/g, symbol);

    return {
      ok: true,
      currency,
      period: period || null,
      contract,
      equity,
      bonus,
      min,
      max,
      annualMin,
      annualMax,
      midpoint: annualMin != null ? (annualMin + annualMax) / 2 : null,
      comparable,
      reason,
      listed: listed ? `Listed ${listed}` : text
    };
  }

  // A market estimate is worth comparing only when all of these hold:
  // confidence is exactly "confident", at least 25 salary reports, the
  // returned title is the requested title (same words, not a seniority or
  // role change), and base pay has a 25th, median, and 75th. Total pay is
  // ignored: the posting's base is compared with base.
  const MIN_SALARY_REPORTS = 25;

  function marketDecision(estimate, requestedTitle) {
    if (!estimate || typeof estimate !== 'object') {
      return { compare: false, reason: 'unavailable' };
    }

    if (estimate.currency && String(estimate.currency).toUpperCase() !== 'USD') {
      return { compare: false, reason: 'currency' };
    }

    if (estimate.pay_period && String(estimate.pay_period).toLowerCase() !== 'annual') {
      return { compare: false, reason: 'period' };
    }

    if (String(estimate.confidence || '').toLowerCase() !== 'confident') {
      return { compare: false, reason: 'confidence' };
    }

    const reports = Number(estimate.salaries_count);

    if (!Number.isFinite(reports) || reports < MIN_SALARY_REPORTS) {
      return { compare: false, reason: 'sample' };
    }

    if (!titlesMatch(requestedTitle, estimate.job_title?.name || estimate.job_title)) {
      return { compare: false, reason: 'title' };
    }

    const base = estimate.base_pay || {};

    if (!(Number(base.p25) > 0) || !(Number(base.p50) > 0) || !(Number(base.p75) > 0)) {
      return { compare: false, reason: 'base' };
    }

    return { compare: true, reason: '' };
  }

  function placementOf(midpoint, base) {
    const pay = Number(midpoint);

    if (pay < Number(base.p25)) {
      return 'below the 25th percentile';
    }

    if (pay > Number(base.p75)) {
      return 'above the 75th';
    }

    return 'within the range';
  }

  function companyBasePay(page, title) {
    const rows = Array.isArray(page?.salaries) ? page.salaries : [];
    const row = rows.find((item) => titlesMatch(title, item?.job_title?.name || item?.job_title));
    return row?.base_pay || null;
  }

  // Glassdoor's salary-estimate bands. A range uses its lower number.
  const SENIORITY = /\b(senior|staff|lead|principal|junior|associate|intern(?:ship)?s?)\b/i;

  function statedYears(text) {
    const source = String(text || '');

    if (/less than\s+(?:a|an|one|1)\s+year/i.test(source)) {
      return 0;
    }

    const experience = source.match(/\b(\d+(?:\.\d+)?)\s*\+?\s*(?:(?:-|–|to)\s*\d+(?:\.\d+)?\s*\+?\s*)?years?(?:\s+of)?\s+(?:[a-z]+\s+){0,3}experience\b/i);

    if (experience) {
      return Number(experience[1]);
    }

    const atLeast = source.match(/(?:at least|minimum(?: of)?)\s+(\d+(?:\.\d+)?)\s*\+?\s*years?\b/i);

    if (atLeast) {
      return Number(atLeast[1]);
    }

    const plain = source.match(/\b(\d+(?:\.\d+)?)\s*\+?\s*(?:(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*\+?\s*)?years?\b(?!\s+ago\b)(?!\s+old\b)/i);

    if (plain) {
      return Number(plain[1]);
    }

    return null;
  }

  function yearsBucket(years) {
    const count = Number(years);

    if (!Number.isFinite(count) || count < 0) {
      return null;
    }

    if (count < 1) {
      return 'less_than_one';
    }

    if (count <= 3) {
      return 'one_to_three';
    }

    if (count <= 6) {
      return 'four_to_six';
    }

    if (count <= 9) {
      return 'seven_to_nine';
    }

    if (count <= 14) {
      return 'ten_to_fourteen';
    }

    return 'above_fifteen';
  }

  // "all" is only for a title with no seniority word and no stated years.
  // A seniority word without a stated year is not compared.
  function experienceChoice(title, text) {
    const years = statedYears(text);

    if (years != null) {
      return { skip: false, bucket: yearsBucket(years), reason: '' };
    }

    if (SENIORITY.test(String(title || ''))) {
      return { skip: true, bucket: null, reason: 'seniority' };
    }

    return { skip: false, bucket: 'all', reason: '' };
  }

  function paySentence(posted, market) {
    const listed = posted?.listed || '';

    if (!market?.compared) {
      return listed;
    }

    const place = market.place || 'this location';
    const reports = Number(market.reports);
    const count = Number.isFinite(reports) ? reports.toLocaleString('en-US') : '0';

    return `${listed} · Market median ${market.medianText} for this title in ${place} (${count} reports)`;
  }

  const api = {
    HOURS_PER_YEAR,
    MIN_SALARY_REPORTS,
    normalizeTitle,
    titlesMatch,
    formatUsdSpan,
    parsePostedPay,
    marketDecision,
    placementOf,
    companyBasePay,
    paySentence,
    statedYears,
    yearsBucket,
    experienceChoice
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  globalThis.GhdPay = api;
})();
