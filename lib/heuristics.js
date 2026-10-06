/**
 * Local scoring used when the backend is unreachable.
 * Vagueness weights match lib/server/vagueness.js.
 * A stated years-of-experience requirement is one specificity signal.
 * Its absence is not a separate penalty.
 * Layoff and review scores come from the backend.
 *
 * The manifest injects this file, and background.js injects it again
 * after a client-side navigation. A second run must not redeclare the
 * top-level constants.
 */
(() => {
  'use strict';

  if (globalThis.__GHD_HEURISTICS__) {
    return;
  }

  globalThis.__GHD_HEURISTICS__ = true;

const ACRONYM_STOP = new Set([
  'AM', 'PM', 'US', 'UK', 'OR', 'AN', 'AS', 'BE', 'IS', 'IT', 'AT', 'BY',
  'TO', 'OF', 'IN', 'ON', 'WE', 'DO', 'IF', 'SO', 'NO', 'OK', 'ID', 'A'
]);
const HEADING_WORDS = new Set(['who', 'we', 'are', 'our', 'about']);
const ROLE_CONTEXT = /\b(using|with|including|via|through|certified|certification|proficient|experience|experienced|knowledge|responsible|maintain|maintaining|build|building|configure|configuring|administer|administering|support|supporting|implement|implementing|manage|managing|develop|developing|design|designing|operate|operating|analyze|analyzing|analysis|reports?|reporting|triage|draft|process|processing|reconcile|document|documents|system|systems|platform|platforms|tool|tools|software|application|applications)\b/i;
const QUANTIFIED_SCOPE = /\b(?:team|group|staff)\s+of\s+\d+\b|\$\s?\d|\b\d[\d,]*\s*(?:%|percent|million|billion)\b|\b\d[\d,]*\s*\+\s*[A-Za-z]|\b\d[\d,]*\s+(?!years?\b|days?\b|weeks?\b|months?\b|hours?\b)[A-Za-z]{4,}s\b/i;
const REPORTING = /\breports?\s+to\b|\bdirect reports?\b|\b(?:manage|manages|managing)\s+\d+\s+[A-Za-z]/i;
const VAGUE_COLLOCATION = /\b(?:support|drive|leverage|champion|spearhead)\s+(?:[\w-]+\s+){0,3}(?:initiatives?|results?|outcomes?|synergies|excellence|innovation|success|change)\b|\bwear many hats\b|\bother duties as assigned\b|\bfast-paced environment\b/i;
const ACTION = /\b(draft(?:s|ed|ing)?|build(?:s|ing)?|built|triage[sd]?|configure[sd]?|configuring|administer(?:s|ed|ing)?|implement(?:s|ed|ing)?|develop(?:s|ed|ing)?|design(?:s|ed|ing)?|analyze[sd]?|analyzing|reconcile[sd]?|audit(?:s|ed|ing)?|document(?:s|ed|ing)?|maintain(?:s|ed|ing)?|deploy(?:s|ed|ing)?|migrate[sd]?|migrating|write[s]?|wrote|writing|review(?:s|ed|ing)?|process(?:es|ed|ing)?|resolve[sd]?|resolving|diagnose[sd]?|install(?:s|ed|ing)?|operate[sd]?|operating|schedule[sd]?|prepare[sd]?|preparing|file[sd]?|filing|counsel(?:s|ed|ing)?|assess(?:es|ed|ing)?|treat(?:s|ed|ing)?|admit(?:s|ted|ting)?|discharge[sd]?|code[sd]?|coding)\b/gi;
const YEARS_STATED = /\b\d+\s*\+?\s*years?\b/i;
// Hype and filler. Ordinary role words such as "leadership" are not on this list.
const BUZZWORD = /\b(?:rockstars?|ninjas?|whizzes|whiz|gurus?|mavericks?|synergy|synergies|disrupt(?:s|ed|ing)?|innovat(?:e|es|ed|ing)|growth mindset|wear many hats|fast-paced environment)\b/gi;

function sentencesOf(text) {
  return String(text || '').split(/(?<=[.!?\n])\s+/).map((part) => part.trim()).filter(Boolean);
}

function capitalizedPhrases(sentence) {
  const tokens = sentence.trim().split(/\s+/).filter(Boolean);
  const phrases = [];
  let run = [];
  let runStart = 0;

  const flush = () => {
    const significant = run.filter((token) => !/^(of|and|the|for|at|&)$/i.test(token));

    if (significant.length >= 2 || (significant.length === 1 && runStart > 0)) {
      phrases.push(significant.join(' '));
    }

    run = [];
  };

  tokens.forEach((raw, index) => {
    const token = raw.replace(/^[("'`“”]+|[)"'`,.;:]+$/g, '');

    if (/^(of|and|the|for|at|&)$/i.test(token) && run.length) {
      run.push(token);
      return;
    }

    if (/^[A-Z][A-Za-z0-9.+/-]*$/.test(token) && !HEADING_WORDS.has(token.toLowerCase())) {
      if (!run.length) {
        runStart = index;
      }

      run.push(token);
      return;
    }

    flush();
  });
  flush();
  return phrases;
}

function namedToolCount(text) {
  const seen = new Set();

  for (const sentence of sentencesOf(text)) {
    if (!ROLE_CONTEXT.test(sentence)) {
      continue;
    }

    for (const match of sentence.matchAll(/\b[A-Z][A-Z0-9]{1,7}\b/g)) {
      if (!ACRONYM_STOP.has(match[0])) {
        seen.add(match[0]);
      }
    }

    for (const phrase of capitalizedPhrases(sentence)) {
      seen.add(phrase.toLowerCase());
    }
  }

  return seen.size;
}

function concreteDeliverableCount(text) {
  const pattern = new RegExp(ACTION.source, 'gi');
  let count = 0;
  let match = pattern.exec(text);

  while (match) {
    const window = text.slice(match.index, match.index + 80);

    if (!VAGUE_COLLOCATION.test(window) && /\b(?:[A-Z][A-Za-z0-9.+/-]{2,}|\d|Tier\s+\d|[a-z]+-[a-z]+)\b/.test(window.slice(match[0].length))) {
      count += 1;
    }

    match = pattern.exec(text);
  }

  return count;
}

function specificitySignals(text) {
  const yearsStripped = text.replace(/\b\d+\s*\+?\s*years?\b/gi, ' ');

  return {
    namedTools: namedToolCount(text),
    quantifiedScope: QUANTIFIED_SCOPE.test(yearsStripped),
    reporting: REPORTING.test(text),
    concreteDeliverables: concreteDeliverableCount(text),
    experienceStated: YEARS_STATED.test(text)
  };
}

function specificityFlags(signals) {
  return [
    signals.namedTools > 0,
    signals.quantifiedScope,
    signals.reporting,
    signals.concreteDeliverables > 0,
    signals.experienceStated
  ];
}

function specificityPenalty(signals) {
  const present = specificityFlags(signals).filter(Boolean).length;

  if (present >= 3) {
    return 0;
  }

  if (present === 2) {
    return 8;
  }

  if (present === 1) {
    return 16;
  }

  return 25;
}

function excludedByTitle(phrase, title) {
  const haystack = String(title || '').toLowerCase();
  const normalized = String(phrase || '').toLowerCase();

  if (!haystack || !normalized) {
    return false;
  }

  if (haystack.includes(normalized)) {
    return true;
  }

  const singular = normalized.endsWith('s') ? normalized.slice(0, -1) : normalized;
  return new RegExp(`\\b${singular.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack);
}

function buzzwordHits(text, title) {
  return [...String(text || '').matchAll(BUZZWORD)]
    .map((match) => match[0].toLowerCase())
    .filter((phrase) => !excludedByTitle(phrase, title));
}

// Hourly ($30.00/hr, $30/hour, $30 - $70 per hour), cents, ranges joined by
// "-", "to", or an en dash, annual figures with or without commas, "k"
// suffixes, and £ € ¥ ₹. Keep this aligned with lib/server/vagueness.js.
const SALARY_PATTERN = /(?:[$£€¥₹]\s?|\b(?:USD|GBP|EUR|CAD|AUD)\s+)\d[\d,]*(?:\.\d+)?(?:\s*[kK])?(?:\s*(?:\/|per)\s*(?:hr|hour|yr|year|annum))?(?:\s*(?:[-–—]|to)\s*(?:[$£€¥₹]\s?|(?:USD|GBP|EUR|CAD|AUD)\s+)?\d[\d,]*(?:\.\d+)?(?:\s*[kK])?(?:\s*(?:\/|per)\s*(?:hr|hour|yr|year|annum))?)?|\b\d[\d,]*(?:\.\d+)?\s*[kK]\b(?:\s*(?:[-–—]|to)\s*\d[\d,]*(?:\.\d+)?\s*[kK]\b)?|\b\d[\d,]*(?:\.\d+)?\s*(?:\/|per)\s*(?:hr|hour)\b/i;

function salarySnippet(description, salary) {
  const pay = String(salary || '').trim();

  if (pay && SALARY_PATTERN.test(pay)) {
    return pay;
  }

  const text = String(description || '');
  const match = text.match(SALARY_PATTERN);

  if (!match) {
    return '';
  }

  const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 24);
  const extra = tail.match(/^\s*(?:\/\s*(?:hr|hour|yr|year)|per\s+(?:hour|year|month)|contract(?:or)?|c2c|1099|freelance)/i);

  return match[0] + (extra ? extra[0] : '');
}

function analyzeVagueness(description, title = '', salary = '') {
  const text = String(description || '').trim();

  if (!text) {
    return {
      score: 0,
      label: 'Not loaded',
      unavailable: true,
      factors: {},
      raw: { wordCount: 0 }
    };
  }

  if (text.length < 50) {
    return {
      score: 30,
      label: 'Too Short',
      unavailable: false,
      factors: {},
      raw: { wordCount: text.split(/\s+/).filter(Boolean).length }
    };
  }

  const words = text.split(/\s+/);
  const pay = String(salary || '').trim();
  const inDescription = SALARY_PATTERN.test(text);
  const inPayRange = !inDescription && SALARY_PATTERN.test(pay);
  const hasSalary = inDescription || inPayRange;
  const salarySource = inDescription ? 'description' : inPayRange ? 'pay-range' : '';
  const questionMarks = (text.match(/\?/g) || []).length;
  const hits = buzzwordHits(text, title);
  const per100Words = words.length ? (hits.length / words.length) * 100 : 0;
  const signals = specificitySignals(text);
  const specificity = specificityPenalty(signals);
  // One hype phrase per 100 words is a mild penalty. Two or more is the old 20.
  // A raw count cannot tell 10 mentions in 300 words from 10 in 2,000.
  const buzzwordScore = per100Words >= 2 ? 20 : per100Words >= 1 ? 10 : 0;

  const factors = {
    wordCount: {
      value: words.length,
      score: words.length < 150 ? 30 : words.length < 250 ? 15 : 0
    },
    hasSalary: {
      value: hasSalary,
      score: hasSalary ? 0 : 10,
      source: salarySource
    },
    questionMarks: {
      value: questionMarks,
      score: questionMarks > 5 ? 15 : 0
    },
    buzzwords: {
      value: {
        count: hits.length,
        per100Words: Math.round(per100Words * 10) / 10
      },
      score: buzzwordScore
    },
    specificity: {
      value: signals,
      score: specificity
    }
  };

  const totalScore = Object.values(factors).reduce((sum, factor) => sum + factor.score, 0);
  const normalizedScore = Math.min(totalScore, 30);
  let label = 'Clear';

  if (normalizedScore >= 20) {
    label = 'Very Vague';
  } else if (normalizedScore >= 10) {
    label = 'Somewhat Vague';
  }

  return {
    score: normalizedScore,
    label,
    unavailable: false,
    factors,
    raw: {
      wordCount: words.length,
      hasSalary,
      salarySource,
      questionMarks,
      buzzwords: hits.length,
      buzzwordDensity: Math.round(per100Words * 10) / 10,
      ...signals,
      specificity
    }
  };
}

// Keep this curve identical to pointsForHiringRatio in lib/server/workforce.js.
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

function analyzeWorkforceSignal(job) {
  const employees = Number(job?.employeeCountEstimate);
  const openJobs = Number(job?.openJobsCount);
  const lowerBound = Boolean(job?.employeesLowerBound);
  const tooltip = lowerBound
    ? 'Employee count is a lower-bound estimate from an open-ended size bucket, so this ratio is less precise than an exact headcount or a closed range. Company hiring for 3+ positions per employee may have inflated postings'
    : 'Company hiring for 3+ positions per employee may have inflated postings';
  const employeeText = lowerBound
    ? String(job?.employeeLabel || `${employees.toLocaleString('en-US')}+`).replace(/\s*employees?$/i, '')
    : employees.toLocaleString('en-US');

  const hasEmployees = Number.isFinite(employees) && employees > 0;
  const hasOpenJobs = Number.isFinite(openJobs) && openJobs > 0;

  if (!hasEmployees || !hasOpenJobs) {
    return {
      available: false,
      score: 0,
      ratio: null,
      employees: hasEmployees ? employees : null,
      openRoles: hasOpenJobs ? openJobs : null,
      label: hasEmployees ? `${employeeText} employees · open roles unknown` : 'Unavailable',
      lowerBound,
      detail: hasEmployees ? '' : 'Public employee count not found for this company.',
      tooltip
    };
  }

  const ratio = Math.round((openJobs / employees) * 100) / 100;
  const score = pointsForHiringRatio(ratio);

  return {
    available: true,
    score,
    ratio,
    employees,
    openRoles: openJobs,
    label: `${employeeText} employees / ${openJobs.toLocaleString('en-US')} open roles = ${ratio}:1 ratio`,
    lowerBound,
    detail: tooltip,
    tooltip
  };
}

// A full check can score only when at least two of these came back with data.
// Unavailable factors are not zero risk; they are missing. A rating drawn from
// fewer than 5 reviews is not one of those factors.
const MIN_INFORMATIVE_REVIEWS = 5;

function reviewIsInformative(reviews) {
  if (reviews?.rating == null || reviews.rating === '') {
    return false;
  }

  if (reviews.reviewCount == null || reviews.reviewCount === '') {
    return true;
  }

  const count = Number(reviews.reviewCount);
  return !Number.isFinite(count) || count >= MIN_INFORMATIVE_REVIEWS;
}

function informativeFactorCount({ layoff, reviews, workforce, reposts } = {}) {
  let count = 0;

  if (layoff && layoff.unavailable !== true) {
    count += 1;
  }

  if (reviewIsInformative(reviews)) {
    count += 1;
  }

  const employees = Number(workforce?.employees);

  if (Number.isFinite(employees) && employees > 0) {
    count += 1;
  }

  if (reposts && reposts.unavailable !== true) {
    count += 1;
  }

  return count;
}

const SIGNAL_LEGEND = 'tools, scope numbers, reporting line, specific tasks, years of experience';

function explainVagueness(vagueness) {
  const factors = vagueness?.factors;

  if (!factors || vagueness.unavailable) {
    return [];
  }

  const lines = [];
  const words = factors.wordCount;

  if ((words?.score || 0) > 0) {
    lines.push(Number(words.value) < 150
      ? `Under 150 words (+${words.score})`
      : `Under 250 words (+${words.score})`);
  }

  if ((factors.hasSalary?.score || 0) > 0) {
    lines.push(`No salary listed (+${factors.hasSalary.score})`);
  }

  if ((factors.questionMarks?.score || 0) > 0) {
    lines.push(`More than 5 question marks (+${factors.questionMarks.score})`);
  }

  if ((factors.buzzwords?.score || 0) > 0) {
    const bar = factors.buzzwords.score >= 20 ? 2 : 1;
    lines.push(`Hype density above ${bar} per 100 words (+${factors.buzzwords.score})`);
  }

  const present = specificityFlags(factors.specificity?.value || {}).filter(Boolean).length;

  if ((factors.specificity?.score || 0) > 0) {
    lines.push(`Only ${present} of 5 concrete-detail signals found`);
  }

  const listed = factors.hasSalary?.source === 'pay-range' ? ['Salary listed'] : [];

  if (lines.length) {
    return [...listed, ...lines].slice(0, 3);
  }

  if (present >= 3) {
    return [...listed, `${present} of 5 concrete-detail signals found (${SIGNAL_LEGEND})`].slice(0, 3);
  }

  return listed;
}

function classifyScore(total) {
  const score = Math.max(0, Math.min(100, Math.round(total)));
  let label;
  let cssClass;

  if (score <= 34) {
    label = 'Ghost Job: Unlikely';
    cssClass = 'unlikely';
  } else if (score <= 49) {
    label = 'Ghost Job: Possible';
    cssClass = 'possible';
  } else {
    label = 'Ghost Job: Likely';
    cssClass = 'likely';
  }

  return { score, label, cssClass };
}

const LOCAL_FACTORS = {
  REPOSTS: { icon: '🔁', label: 'Reposts' },
  LAYOFFS: { icon: '📉', label: 'Recent Layoffs' },
  REVIEWS: { icon: '⭐', label: 'Company Reviews' },
  CLARITY: { icon: '📝', label: 'Description Clarity' },
  WORKFORCE: { icon: '🏢', label: 'Company size' }
};

const JOB_AGE_LIMIT = 40;

function listingDate(match) {
  const text = String(match?.dateLabel || '').trim();

  if (!text || /^date not shown$/i.test(text)) {
    return '';
  }

  return text;
}

function postedAtFromLabel(label, now) {
  const match = String(label || '').match(/(\d+)\s+(hour|day|week|month|year)s?\s+ago/i);

  if (!match) {
    return null;
  }

  const count = Number(match[1]);
  const unit = match[2].toLowerCase();
  const span = {
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000
  }[unit];

  if (!span || !Number.isFinite(count)) {
    return null;
  }

  return now - count * span;
}

function boundJobAges(pairs) {
  const list = pairs
    .map((pair) => ({ jobId: Number(pair.jobId), postedAt: Number(pair.postedAt) }))
    .filter((pair) => Number.isFinite(pair.jobId) && Number.isFinite(pair.postedAt));

  while (list.length > JOB_AGE_LIMIT) {
    list.sort((left, right) => left.jobId - right.jobId);
    let drop = 0;
    let smallest = Infinity;

    for (let index = 0; index < list.length; index += 1) {
      const previous = list[index - 1]?.jobId ?? list[index].jobId;
      const following = list[index + 1]?.jobId ?? list[index].jobId;
      const gap = following - previous;

      if (gap < smallest) {
        smallest = gap;
        drop = index;
      }
    }

    list.splice(drop, 1);
  }

  return list;
}

function rememberJobAge(pairs, jobId, label, now) {
  const id = Number(String(jobId || '').match(/(\d{5,})/)?.[1] || jobId);
  const postedAt = postedAtFromLabel(label, now instanceof Date ? now.getTime() : now);
  const current = Array.isArray(pairs) ? pairs : [];

  if (!Number.isFinite(id) || postedAt == null) {
    return current.slice();
  }

  return boundJobAges([
    ...current.filter((pair) => Number(pair.jobId) !== id),
    { jobId: id, postedAt }
  ]);
}

function coarseEarlier(days) {
  if (!Number.isFinite(days) || days < 0) {
    return 'date not shown';
  }

  if (days < 60) {
    const weeks = Math.max(1, Math.round(days / 7));
    return `about ${weeks} ${weeks === 1 ? 'week' : 'weeks'} earlier (estimated)`;
  }

  const months = Math.max(2, Math.round(days / 30));
  return `about ${months} ${months === 1 ? 'month' : 'months'} earlier (estimated)`;
}

function estimateEarlierAge(jobId, pairs, now) {
  const points = (Array.isArray(pairs) ? pairs : [])
    .map((pair) => ({ jobId: Number(pair.jobId), postedAt: Number(pair.postedAt) }))
    .filter((pair) => Number.isFinite(pair.jobId) && Number.isFinite(pair.postedAt))
    .sort((left, right) => left.jobId - right.jobId);
  const id = Number(jobId);
  const time = now instanceof Date ? now.getTime() : Number(now);

  if (points.length < 2 || !Number.isFinite(id) || !Number.isFinite(time)) {
    return 'date not shown';
  }

  const span = points[points.length - 1].jobId - points[0].jobId;

  if (span <= 0 || id < points[0].jobId - span || id > points[points.length - 1].jobId + span) {
    return 'date not shown';
  }

  if (id < points[0].jobId || id > points[points.length - 1].jobId) {
    return 'date not shown';
  }

  let lower = points[0];
  let upper = points[points.length - 1];

  for (let index = 0; index < points.length - 1; index += 1) {
    if (points[index].jobId <= id && points[index + 1].jobId >= id) {
      lower = points[index];
      upper = points[index + 1];
      break;
    }
  }

  if (upper.jobId === lower.jobId) {
    return 'date not shown';
  }

  const fraction = (id - lower.jobId) / (upper.jobId - lower.jobId);
  const postedAt = lower.postedAt + fraction * (upper.postedAt - lower.postedAt);

  return coarseEarlier((time - postedAt) / (24 * 60 * 60 * 1000));
}

function linkedInJobId(url) {
  const match = String(url || '').match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d+)/i);
  return match ? Number(match[1]) : NaN;
}

// Keep aligned with samePosting() in lib/server/reposts.js.
function addPostingId(ids, value) {
  const id = String(value || '').trim();

  if (/^\d+$/.test(id)) {
    ids.add(id);
  }
}

function postingIdsInUrl(url) {
  const ids = new Set();
  const raw = String(url || '').trim();

  if (!raw) {
    return ids;
  }

  try {
    const parsed = new URL(raw, 'https://www.linkedin.com');
    addPostingId(ids, parsed.searchParams.get('currentJobId'));
    const view = parsed.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/i);

    if (view) {
      addPostingId(ids, view[1]);
    }
  } catch {
    const query = raw.match(/[?&]currentJobId=(\d+)/i);
    const view = raw.match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d+)/i);

    if (query) {
      addPostingId(ids, query[1]);
    }

    if (view) {
      addPostingId(ids, view[1]);
    }
  }

  return ids;
}

function postingIds(job) {
  const ids = postingIdsInUrl(job?.url);
  addPostingId(ids, job?.jobId);
  return ids;
}

function canonicalPostingUrl(url) {
  const raw = String(url || '').trim();

  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw, 'https://www.linkedin.com');
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const ids = [...postingIdsInUrl(parsed.href)];

    if (/linkedin\.com$/i.test(host) && /\/jobs\/view\//i.test(parsed.pathname) && ids.length) {
      return `https://www.linkedin.com/jobs/view/${ids[0]}`;
    }

    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    const current = parsed.searchParams.get('currentJobId');
    const query = current && /^\d+$/.test(current) ? `?currentjobid=${current}` : '';
    return `https://${host}${path}${query}`;
  } catch {
    return raw.split('#')[0].replace(/\/+$/, '').toLowerCase();
  }
}

function samePosting(job, url) {
  const mine = postingIds(job);

  for (const id of postingIdsInUrl(url)) {
    if (mine.has(id)) {
      return true;
    }
  }

  const left = canonicalPostingUrl(job?.url);
  const right = canonicalPostingUrl(url);
  return Boolean(left && right && left === right);
}

function withoutSelfMatches(repostInfo) {
  const job = { jobId: repostInfo?.jobId || '', url: repostInfo?.url || '' };
  const matches = Array.isArray(repostInfo?.matches) ? repostInfo.matches : null;

  if (!matches || (!postingIds(job).size && !job.url)) {
    return repostInfo;
  }

  const kept = matches.filter((match) => match?.url && !samePosting(job, match.url));

  if (kept.length === matches.length) {
    return repostInfo;
  }

  if (!kept.length) {
    return { ...repostInfo, score: 0, count: 0, matches: [], dates: [] };
  }

  return {
    ...repostInfo,
    matches: kept,
    count: kept.length,
    dates: kept.map((match) => match.dateLabel || '')
  };
}

function matchAge(match, repostInfo) {
  const real = listingDate(match);

  if (real) {
    return real;
  }

  return estimateEarlierAge(linkedInJobId(match?.url), repostInfo?.idDates, repostInfo?.now || Date.now());
}

function repostFactor(repostInfo) {
  repostInfo = withoutSelfMatches(repostInfo);

  if (repostInfo?.unavailable || repostInfo?.available === false) {
    return {
      ...LOCAL_FACTORS.REPOSTS,
      value: 'Unavailable',
      detail: repostInfo?.detail || 'Repost search did not return results.',
      indicator: null,
      severity: 'neutral'
    };
  }

  const matches = (Array.isArray(repostInfo?.matches) ? repostInfo.matches : []).filter((match) => match?.url);

  if (matches.length >= 1) {
    const count = matches.length;
    const posting = count === 1 ? 'posting matches' : 'postings match';

    return {
      ...LOCAL_FACTORS.REPOSTS,
      value: count === 1 ? '1 other posting' : `${count} other postings`,
      detail: `${count} LinkedIn ${posting} this title, company, and location.`,
      entries: matches.map((match) => ({
        text: matchAge(match, repostInfo),
        href: match.url,
        linkLabel: 'source',
        title: 'This posting may have been removed.'
      })),
      indicator: '⚠️',
      severity: 'danger'
    };
  }

  if ((repostInfo?.score || 0) >= 20) {
    return {
      ...LOCAL_FACTORS.REPOSTS,
      value: 'Older than 7 days',
      detail: repostInfo.detail || '',
      indicator: '⚠️',
      severity: 'warning'
    };
  }

  return {
    ...LOCAL_FACTORS.REPOSTS,
    value: 'No duplicate found',
    detail: repostInfo?.detail || 'No other LinkedIn posting matched this role.',
    indicator: '✓',
    severity: 'success'
  };
}

function describeWorkforce(workforce) {
  const names = {
    crunchbase: 'Crunchbase',
    website: 'company site',
    search: 'search',
    apollo: 'Apollo'
  };
  const source = names[workforce?.employeeSource];
  const label = workforce?.label || '';

  if (workforce?.employeeSource === 'search' && label && label !== 'Unavailable' && !/\(estimated/i.test(label)) {
    return `${label} (estimated, search)`;
  }

  if (workforce?.estimated && label && label !== 'Unavailable' && !/\(estimated\)/i.test(label)) {
    return `${label} (estimated)`;
  }

  if (!source || !label || label === 'Unavailable') {
    return label;
  }

  const estimated = label.startsWith('~') ? label : `~${label}`;

  if (/\(estimated/i.test(estimated)) {
    return estimated.includes(source) ? estimated : estimated.replace(/\)\s*$/, `, ${source})`);
  }

  return `${estimated} (estimated, ${source})`;
}

function formatReviewCount(count) {
  const value = Number(count);

  if (!Number.isFinite(value) || value <= 0) {
    return '';
  }

  const rounded = Math.round(value);
  return ` (${rounded.toLocaleString('en-US')} ${rounded === 1 ? 'review' : 'reviews'})`;
}

function buildFactors(vagueness, layoff, workforce, reviews, reposts) {
  const reviewInfo = reviews || { rating: null, unavailable: true, score: 0 };
  const repostInfo = reposts || {
    score: 0,
    detail: 'Open the DuckDuckGo search below.'
  };

  let reviewValue = 'No rating found';
  let reviewSeverity = 'neutral';
  let reviewIndicator = null;
  let reviewDetail = reviewInfo.detail || '';

  if (!reviewInfo.unavailable && reviewInfo.rating == null) {
    reviewValue = 'No public reviews found';
    reviewDetail = reviewInfo.detail && reviewInfo.detail !== 'No public reviews found' ? reviewInfo.detail : '';
  } else if (reviewInfo.unavailable) {
    reviewValue = 'Check unavailable';
    reviewDetail = reviewInfo.detail || 'Review search did not return a page.';
  } else if (reviewInfo.rating != null) {
    reviewValue = `${reviewInfo.rating} / 5 on ${reviewInfo.platform || 'reviews'}${formatReviewCount(reviewInfo.reviewCount)}`;
    // The icon follows the rating. A thin count zeroes the points without
    // turning a low rating into a clear one.
    const ratingWarns = Number(reviewInfo.rating) <= 3.5;
    reviewIndicator = ratingWarns ? '⚠️' : '✓';
    reviewSeverity = ratingWarns ? 'warning' : 'success';
  }

  const workforceRatio = Number(workforce?.ratio);
  const workforceSeverity = !workforce?.available
    ? 'neutral'
    : workforceRatio >= 3
      ? 'danger'
      : (workforce?.score || 0) > 0
        ? 'warning'
        : 'success';
  const workforceLabel = describeWorkforce(workforce);
  const headcountNote = String(workforce?.employeeDiscrepancy || '').trim();
  const sizeLabel = workforceLabel && workforceLabel !== 'Unavailable' ? workforceLabel : '';
  const workforceFactor = workforce?.available
    ? {
        ...LOCAL_FACTORS.WORKFORCE,
        value: workforceLabel,
        detail: [
          workforce?.employeeSource === 'search' ? 'Estimated from search' : '',
          workforce?.openJobsEstimated ? 'Open roles estimated from search' : ''
        ].filter(Boolean).join(' '),
        href: workforce?.employeeSourceUrl || '',
        tooltip: [workforce.tooltip || workforce.detail, headcountNote].filter(Boolean).join(' '),
        indicator: (workforce?.score || 0) > 0 ? '⚠️' : '✓',
        severity: workforceSeverity,
        valueClass: workforceSeverity
      }
    : (Number(workforce?.employees) > 0 || sizeLabel)
      ? {
          ...LOCAL_FACTORS.WORKFORCE,
          value: sizeLabel
            || `${Number(workforce.employees).toLocaleString('en-US')} employees · open roles unknown`,
          detail: '',
          tooltip: [workforce?.tooltip, headcountNote].filter(Boolean).join(' '),
          indicator: null,
          severity: 'neutral'
        }
      : {
          ...LOCAL_FACTORS.WORKFORCE,
          value: 'Unavailable',
          detail: workforce?.detail || 'Public employee count not found for this company.',
          tooltip: workforce?.tooltip || '',
          indicator: null,
          severity: 'neutral'
        };

  return [
    {
      ...LOCAL_FACTORS.CLARITY,
      value: vagueness?.label || 'Unknown',
      explain: explainVagueness(vagueness),
      detail: vagueness?.unavailable ? 'Open the full posting to score the description' : '',
      indicator: vagueness?.unavailable ? null : vagueness.score > 15 ? '⚠️' : '✓',
      severity: vagueness?.unavailable
        ? 'neutral'
        : vagueness.score > 20
          ? 'danger'
          : vagueness.score > 10
            ? 'warning'
            : 'success'
    },
    {
      ...LOCAL_FACTORS.LAYOFFS,
      value: layoff?.unavailable
        ? 'Check unavailable'
        : layoff?.detected
          ? `Yes (${layoff.date || 'date unknown'})`
          : 'No recent coverage',
      detail: layoff?.headline || layoff?.detail || '',
      href: layoff?.detected ? (layoff.url || '') : '',
      indicator: layoff?.unavailable ? null : layoff?.detected ? '⚠️' : '✓',
      severity: layoff?.unavailable ? 'neutral' : layoff?.detected ? 'danger' : 'success'
    },
    {
      ...LOCAL_FACTORS.REVIEWS,
      value: reviewValue,
      detail: reviewDetail,
      indicator: reviewIndicator,
      severity: reviewSeverity
    },
    workforceFactor,
    repostFactor(repostInfo)
  ];
}

function calculateGhostScore({ vagueness, layoff, workforce = {}, reviews = {}, reposts = {} }) {
  const components = {
    vagueness: Math.min(vagueness?.score || 0, 30),
    layoffs: layoff?.detected ? Math.min(layoff.score || 25, 25) : 0,
    reviews: Math.min(reviews?.score || 0, 15),
    // 40 is the confirmed-duplicate score. One repost stays in Possible.
    // Likely needs this plus another factor. Keep aligned with REPOST_CAP.
    reposts: Math.min(reposts?.score || 0, 40),
    // Display only. The server score leaves this out as well.
    hiringRatio: 0
  };
  console.info('[GHD] ghost score', {
    ratio: workforce?.ratio ?? null,
    employees: workforce?.employees ?? null,
    openRoles: workforce?.openRoles ?? null,
    workforceScore: workforce?.score || 0,
    hiringRatioComponent: components.hiringRatio,
    label: workforce?.label || ''
  });
  const total = Object.values(components).reduce((sum, value) => sum + value, 0);

  return {
    ...classifyScore(total),
    components
  };
}

async function analyzeJob(job) {
  const vagueness = analyzeVagueness(job?.description || '', job?.title || '', job?.salary || '');
  const workforce = analyzeWorkforceSignal(job);
  const layoff = {
    detected: false,
    unavailable: true,
    date: null,
    score: 0,
    detail: 'Backend layoff check did not run'
  };
  const reviews = {
    rating: null,
    unavailable: false,
    score: 0,
    detail: 'No public reviews found'
  };
  const reposts = {
    score: 0,
    unavailable: true,
    available: false,
    detail: 'Repost search did not run.'
  };
  const score = calculateGhostScore({ vagueness, layoff, workforce, reviews, reposts });

  return {
    source: 'local',
    score,
    factors: buildFactors(vagueness, layoff, workforce, reviews, reposts),
    evidence: {
      vagueness,
      layoff,
      workforce,
      reviews,
      reposts
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    analyzeVagueness,
    analyzeWorkforceSignal,
    analyzeJob,
    buildFactors,
    calculateGhostScore,
    classifyScore,
    rememberJobAge,
    estimateEarlierAge,
    withoutSelfMatches,
    informativeFactorCount,
    salarySnippet
  };
}

if (typeof window !== 'undefined') {
  window.GhostJobHeuristics = {
    analyzeVagueness,
    analyzeWorkforceSignal,
    analyzeJob,
    buildFactors,
    calculateGhostScore,
    classifyScore,
    rememberJobAge,
    estimateEarlierAge,
    withoutSelfMatches,
    informativeFactorCount,
    salarySnippet
  };
}
})();
