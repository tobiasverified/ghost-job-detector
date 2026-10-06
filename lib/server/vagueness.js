/**
 * Keep this aligned with analyzeVagueness in lib/heuristics.js.
 * Empty text is "not loaded" and does not add risk.
 * A present-but-tiny description still does.
 *
 * Specificity replaces the old fixed tech-keyword list. It looks for
 * concrete content in any field: named tools, quantified scope,
 * a reporting line, a verb tied to a specific object, and a stated
 * years-of-experience requirement. Missing that phrase is not a penalty.
 */
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

function specificityPenalty(signals) {
  const present = [
    signals.namedTools > 0,
    signals.quantifiedScope,
    signals.reporting,
    signals.concreteDeliverables > 0,
    signals.experienceStated
  ].filter(Boolean).length;

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
// suffixes, and £ € ¥ ₹. Keep this aligned with analyzeVagueness in lib/heuristics.js.
const SALARY_PATTERN = /(?:[$£€¥₹]\s?|\b(?:USD|GBP|EUR|CAD|AUD)\s+)\d[\d,]*(?:\.\d+)?(?:\s*[kK])?(?:\s*(?:\/|per)\s*(?:hr|hour|yr|year|annum))?(?:\s*(?:[-–—]|to)\s*(?:[$£€¥₹]\s?|(?:USD|GBP|EUR|CAD|AUD)\s+)?\d[\d,]*(?:\.\d+)?(?:\s*[kK])?(?:\s*(?:\/|per)\s*(?:hr|hour|yr|year|annum))?)?|\b\d[\d,]*(?:\.\d+)?\s*[kK]\b(?:\s*(?:[-–—]|to)\s*\d[\d,]*(?:\.\d+)?\s*[kK]\b)?|\b\d[\d,]*(?:\.\d+)?\s*(?:\/|per)\s*(?:hr|hour)\b/i;

export function analyzeVagueness(description, title = '', salary = '') {
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
