import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { analyzeVagueness } from '../lib/server/vagueness.js';

function loadHeuristics() {
  const sandbox = { console };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../lib/heuristics.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.module.exports;
}

const heuristics = loadHeuristics();

function atLeast250Words(text) {
  let next = text;

  while (next.split(/\s+/).filter(Boolean).length < 260) {
    next += ' The hiring manager reviews this responsibility during the interview.';
  }

  return next;
}

const SOFTWARE = `
The platform team builds deployment pipelines on AWS using Python, React, and Kubernetes.
You will design service APIs, maintain Terraform modules, and review pull requests for the checkout platform.
This role reports to the Engineering Manager and leads a team of 6 engineers.
You will process 200+ deploys each month and manage a $2M infrastructure budget.
Requirements include 5 years of experience with SQL and Docker.
The salary range is $160,000-$190,000.
On a typical week you deploy canary releases, document runbooks for the payments service, and configure IAM roles for new microservices.
You also reconcile failed jobs in the queue and write integration tests around the billing API.
The team owns the production Kubernetes clusters and the CI pipeline that ships them.
Candidates should be comfortable operating Postgres and reading traces when a deploy misbehaves.
`.trim();

const SOFTWARE_POSTING = atLeast250Words(SOFTWARE);

const HEALTH = `
The UHealth-University of Miami Health System IT Department has an opportunity for a full-time Epic Senior Analyst, HB.
You will draft Epic build specifications, configure Hyperspace workqueues, and reconcile hospital billing claims in Resolute Hospital Billing.
This role reports to the Manager of Clinical Applications.
The analyst supports a team of 8 credentialed trainers and processes 200+ claims weekly.
Required qualifications include 3 years of Epic experience and an active Epic certification.
The salary range is $110,000-$130,000.
Day to day you maintain the HB charge router, document build specifications for new clinical departments, and triage Tier 2 tickets from Patient Access.
You will also audit claim edits before they reach the payer and prepare month-end reconciliation files for the billing office.
The analyst partners with hospital billing supervisors on workqueue design and trains staff on the Hyperspace workflows those queues support.
`.trim();

const HEALTH_POSTING = atLeast250Words(HEALTH);

const VAGUE_SOFTWARE = `
We are looking for a passionate rockstar to drive results and support initiatives in a fast-paced environment.
You will wear many hats, leverage synergy, and disrupt the status quo.
Other duties as assigned. We value a growth mindset and want someone who can champion success across the business.
This is a great opportunity for a guru who likes to innovate.
${'You will support key initiatives and drive results for the team. '.repeat(40)}
5 years of experience is preferred.
`.trim();

const VAGUE_HEALTH = `
We are seeking a passionate caregiver to drive patient outcomes and support clinical initiatives.
You will wear many hats in a fast-paced environment and champion excellence across the organization.
Other duties as assigned. A growth mindset and a commitment to synergy are essential.
${'You will support strategic initiatives and drive results for our patients. '.repeat(40)}
3 years of experience is preferred.
`.trim();

function explain(result) {
  return `${result.label} (${result.score}) specificity=${result.raw.specificity} tools=${result.raw.namedTools} scope=${result.raw.quantifiedScope} reporting=${result.raw.reporting} deliverables=${result.raw.concreteDeliverables} years=${result.raw.experienceStated} buzz=${result.raw.buzzwords}@${result.raw.buzzwordDensity}/100 words=${result.raw.wordCount}`;
}

test('description clarity explains the points behind Very Vague and Clear', () => {
  const vagueText = 'We need someone with 5 years of experience. '.repeat(8);
  const vague = heuristics.analyzeVagueness(vagueText);
  const vagueRow = heuristics.buildFactors(
    vague,
    { unavailable: true, detected: false, score: 0 },
    { available: false },
    { unavailable: true, rating: null, score: 0 },
    { unavailable: true, available: false, score: 0 }
  ).find((factor) => factor.label === 'Description Clarity');
  let clearText = `
    The platform team uses Python and AWS for deployment pipelines.
    Monthly volume is 200+ requests.
    Requirements include 5 years of experience with SQL.
    The salary range is $160,000-$190,000.
  `;

  while (clearText.split(/\s+/).filter(Boolean).length < 260) {
    clearText += ' The team keeps the service running for customers.';
  }
  const clear = heuristics.analyzeVagueness(clearText);
  const clearRow = heuristics.buildFactors(
    clear,
    { unavailable: true, detected: false, score: 0 },
    { available: false },
    { unavailable: true, rating: null, score: 0 },
    { unavailable: true, available: false, score: 0 }
  ).find((factor) => factor.label === 'Description Clarity');

  assert.equal(vague.label, 'Very Vague');
  assert.equal(JSON.stringify(vagueRow.explain), JSON.stringify([
    'Under 150 words (+30)',
    'No salary listed (+10)',
    'Only 1 of 5 concrete-detail signals found'
  ]));
  assert.equal(clear.label, 'Clear');
  assert.equal(clear.score < 10, true);
  assert.equal(JSON.stringify(clearRow.explain), JSON.stringify([
    '3 of 5 concrete-detail signals found (tools, scope numbers, reporting line, specific tasks, years of experience)'
  ]));
});

test('a detailed software posting keeps a path through specificity, not a tech-keyword list', () => {
  const result = analyzeVagueness(SOFTWARE_POSTING);
  const client = heuristics.analyzeVagueness(SOFTWARE_POSTING);

  assert.equal(result.raw.specificity, 0, explain(result));
  assert.notEqual(result.label, 'Very Vague', explain(result));
  assert.equal(result.label, 'Clear', explain(result));
  assert.equal(client.label, result.label);
  assert.equal(client.score, result.score);
});

test('a detailed UMiami Epic analyst posting is not Very Vague just because it is not a software stack', () => {
  const result = analyzeVagueness(HEALTH_POSTING);

  assert.equal(result.raw.specificity, 0, explain(result));
  assert.equal(result.label, 'Clear', explain(result));
  assert.equal(heuristics.analyzeVagueness(HEALTH_POSTING).label, result.label);
});

test('a long vague software posting is still Very Vague', () => {
  const result = analyzeVagueness(VAGUE_SOFTWARE);

  assert.ok(result.raw.specificity >= 16, explain(result));
  assert.equal(result.label, 'Very Vague', explain(result));
  assert.equal(heuristics.analyzeVagueness(VAGUE_SOFTWARE).label, result.label);
});

test('a long specific posting is not Very Vague just because it never says N years', () => {
  const posting = atLeast250Words(`
    Head of Product. You will design the guest experience platform and maintain the ticketing system.
    This role reports to the Chief Product Officer and leads a team of 8 product managers.
    You will process 200+ live events each season. The salary range is $180,000-$220,000.
    Product leadership reviews the roadmap with the leadership team each quarter.
  `);
  const result = analyzeVagueness(posting, 'Head of Product');

  assert.equal(result.raw.experienceStated, false, explain(result));
  assert.equal(result.raw.specificity, 0, explain(result));
  assert.equal(result.factors.buzzwords.score, 0, explain(result));
  assert.notEqual(result.label, 'Very Vague', explain(result));
  assert.equal(heuristics.analyzeVagueness(posting, 'Head of Product').label, result.label);
});

test('a hype word that is also the job title does not count', () => {
  const posting = atLeast250Words(`
    The Python Ninja designs service APIs on AWS, maintains Terraform, and reviews pull requests.
    This role reports to the Engineering Manager and leads a team of 6. Salary is $160,000-$190,000.
    You will process 200+ deploys. 5 years of experience with Python is required.
  `);
  const counted = analyzeVagueness(`${posting} We need a ninja.`, 'Engineer');
  const titled = analyzeVagueness(`${posting} We need a ninja.`, 'Python Ninja');

  assert.ok(counted.raw.buzzwords >= 1, explain(counted));
  assert.equal(titled.raw.buzzwords, 0, explain(titled));
});

test('a LinkedIn pay-range block counts as salary listed', () => {
  const description = atLeast250Words('The analyst supports clinical systems and documents the workflow for each department.');
  const pay = 'Base pay range $30.00/hr - $70.00/hr';
  const server = analyzeVagueness(description, 'Clinical Systems Analyst', pay);
  const client = heuristics.analyzeVagueness(description, 'Clinical Systems Analyst', pay);
  const row = heuristics.buildFactors(
    client,
    { unavailable: true, detected: false, score: 0 },
    { available: false },
    { unavailable: true, rating: null, score: 0 },
    { unavailable: true, available: false, score: 0 }
  ).find((factor) => factor.label === 'Description Clarity');

  assert.equal(server.raw.hasSalary, true);
  assert.equal(server.factors.hasSalary.score, 0);
  assert.equal(server.factors.hasSalary.source, 'pay-range');
  assert.equal(server.raw.wordCount, analyzeVagueness(description).raw.wordCount);
  assert.equal(client.raw.hasSalary, true);
  assert.equal(client.factors.hasSalary.source, 'pay-range');
  assert.equal(JSON.stringify(row.explain).includes('Salary listed'), true);
  assert.equal(JSON.stringify(row.explain).includes('No salary listed'), false);
});

test('existing salary formats still count', () => {
  const inDescription = [
    '$160,000-$190,000',
    '80k-100k',
    '80k to 100k',
    '$30.00/hr - $70.00/hr',
    '$30/hour',
    '$30 - $70 per hour',
    '$30.00/hr \u2013 $70.00/hr',
    '$160,000 a year'
  ];
  const payBlockOnly = [
    '$160,000',
    '£50,000',
    '€80k',
    'USD 120,000'
  ];
  const body = atLeast250Words('The team documents the workflow for each department.');

  for (const format of inDescription) {
    const result = analyzeVagueness(`${body} ${format}`);
    const client = heuristics.analyzeVagueness(`${body} ${format}`);
    assert.equal(result.raw.hasSalary, true, format);
    assert.equal(result.factors.hasSalary.source, 'description', format);
    assert.equal(client.raw.hasSalary, true, format);
  }

  for (const format of payBlockOnly) {
    const inPosting = analyzeVagueness(`${body} ${format}`);
    const inBlock = analyzeVagueness(body, 'Analyst', format);
    assert.equal(inPosting.raw.hasSalary, false, format);
    assert.equal(inBlock.raw.hasSalary, true, format);
    assert.equal(inBlock.factors.hasSalary.source, 'pay-range', format);
    assert.equal(heuristics.analyzeVagueness(`${body} ${format}`).raw.hasSalary, false, format);
    assert.equal(heuristics.analyzeVagueness(body, 'Analyst', format).raw.hasSalary, true, format);
  }
});

test('Baker Tilly revenue of $5.2 billion is not listed pay', () => {
  const sentence = 'Baker Tilly is an accounting and advisory firm with $5.2 billion in revenue.';
  const posting = atLeast250Words(sentence);
  const scales = ['$5.2 billion', '$5.2B', '$5.2 M', '$2M', 'USD 5.2 million'];

  for (const scale of scales) {
    const result = analyzeVagueness(atLeast250Words(`The firm reported ${scale} in revenue.`));
    const client = heuristics.analyzeVagueness(atLeast250Words(`The firm reported ${scale} in revenue.`));
    assert.equal(result.raw.hasSalary, false, scale);
    assert.equal(result.factors.hasSalary.score, 10, scale);
    assert.equal(client.raw.hasSalary, false, scale);
    assert.equal(client.factors.hasSalary.score, 10, scale);
  }

  const server = analyzeVagueness(posting);
  const client = heuristics.analyzeVagueness(posting);
  assert.equal(server.raw.hasSalary, false);
  assert.equal(client.raw.hasSalary, false);
  assert.equal(heuristics.salarySnippet(sentence, ''), '');
  assert.equal(heuristics.salarySnippet(posting, '$5.2 billion'), '');
  assert.equal(heuristics.salarySnippet('Revenue was $5.2 billion. The range is $130,000 to $160,000 a year.', ''), '$130,000 to $160,000 a year');
});

test('a long vague healthcare posting is still Very Vague', () => {
  const result = analyzeVagueness(VAGUE_HEALTH);

  assert.ok(result.raw.specificity >= 16, explain(result));
  assert.equal(result.label, 'Very Vague', explain(result));
  assert.equal(heuristics.analyzeVagueness(VAGUE_HEALTH).label, result.label);
});
