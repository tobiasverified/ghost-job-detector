import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// A small stand-in for the page: the panel's HTML is kept as a string, and
// buttons found by id can be clicked from the test.
function loadWidget() {
  const handlers = new Map();
  const panel = { innerHTML: '' };
  const sent = [];
  const pendingReplies = [];

  function control(id) {
    if (!panel.innerHTML.includes(`id="${id}"`)) {
      return null;
    }

    return {
      disabled: false,
      addEventListener(type, handler) {
        handlers.set(id, handler);
      },
      replaceWith() {}
    };
  }

  const shadow = {
    children: [],
    append(...nodes) {
      this.children.push(...nodes);
    },
    querySelector() {
      return panel;
    },
    getElementById: control
  };
  const host = {
    style: {},
    isConnected: false,
    attachShadow() {
      return shadow;
    },
    addEventListener() {}
  };
  const sandbox = {
    URL,
    console: { ...console, info() {} },
    performance,
    setTimeout,
    clearTimeout,
    document: {
      createElement(tag) {
        return tag === 'div' && !host.isConnected && !host.created
          ? Object.assign(host, { created: true })
          : { tag, className: '', textContent: '', style: {} };
      },
      documentElement: {
        appendChild(node) {
          node.isConnected = true;
        }
      },
      querySelectorAll() {
        return [];
      }
    },
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {} } },
      runtime: {
        sendMessage(message) {
          sent.push(message);
          return new Promise((resolve) => pendingReplies.push(resolve));
        }
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../lib/heuristics.js', import.meta.url), 'utf8'), sandbox);
  vm.runInContext(readFileSync(new URL('../lib/widget.js', import.meta.url), 'utf8'), sandbox);

  return {
    widget: sandbox.GhdWidget,
    heuristics: sandbox.GhostJobHeuristics,
    panel,
    sent,
    click(id) {
      const handler = handlers.get(id);
      assert.ok(handler, `no ${id} button on the panel`);
      handler();
    },
    reply(index, analysis) {
      pendingReplies[index]({ ok: true, analysis });
    }
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const description = 'You will build Python services with 5 years of experience. Salary $150,000. Specific duties are listed for each quarter.';
const jobA = { jobId: '101', title: 'Analyst', company: 'Acme', description, url: 'https://www.linkedin.com/jobs/view/101' };
const jobB = { jobId: '202', title: 'Engineer', company: 'Initech', description, url: 'https://www.linkedin.com/jobs/view/202' };

function remoteAnalysis(rating) {
  return {
    ghostScore: 10,
    label: 'Ghost Job: Unlikely',
    factors: {
      layoffs: { detected: false, unavailable: false, score: 0 },
      reviews: { rating, platform: 'Glassdoor', score: 0, unavailable: false },
      reposts: { score: 0, unavailable: false },
      hiringRatio: { available: false, score: 0 }
    },
    cached: false
  };
}

test('a full check with fewer than two informative factors shows no score', async () => {
  const page = loadWidget();
  const blank = {
    layoff: { unavailable: false, detected: false, score: 0 },
    reviews: { unavailable: false, rating: null, score: 0, detail: 'No public reviews found' },
    workforce: { available: false, employees: null, score: 0 },
    reposts: { unavailable: true, available: false, score: 0 }
  };
  const scored = {
    layoff: { unavailable: true, detected: false, score: 0 },
    reviews: { rating: 3.6, unavailable: false, score: 4, platform: 'Glassdoor' },
    workforce: { available: false, employees: null, score: 0 },
    reposts: { unavailable: false, available: true, score: 0, detail: 'No other LinkedIn posting matched this role.' }
  };

  assert.equal(page.heuristics.informativeFactorCount(blank), 1);
  assert.equal(page.heuristics.informativeFactorCount(scored), 2);

  await page.widget.analyze({
    jobId: 'blank',
    title: 'Analyst',
    company: 'Acme',
    description: 'Too short to score.',
    url: 'https://www.linkedin.com/jobs/view/blank'
  });
  page.click('ghd-full');
  await flush();
  page.reply(0, {
    ghostScore: 30,
    label: 'Ghost Job: Unlikely',
    factors: {
      vagueness: { score: 30, label: 'Too Short' },
      layoffs: blank.layoff,
      reviews: blank.reviews,
      hiringRatio: blank.workforce,
      reposts: blank.reposts
    },
    cached: false
  });
  await flush();

  const withheld = page.panel.innerHTML;
  assert.match(withheld, /Not enough data to score/);
  assert.doesNotMatch(withheld, /class="number"/);
  assert.doesNotMatch(withheld, /stroke-dasharray/);
  assert.doesNotMatch(withheld, /Unlikely/);
  assert.match(withheld, /No recent coverage/);
  assert.match(withheld, /No public reviews found/);
  assert.match(withheld, />Unavailable</);

  const scoredPage = loadWidget();
  await scoredPage.widget.analyze(jobA);
  scoredPage.click('ghd-full');
  await flush();
  scoredPage.reply(0, {
    ghostScore: 4,
    label: 'Ghost Job: Unlikely',
    factors: {
      vagueness: { score: 0, label: 'Clear' },
      layoffs: scored.layoff,
      reviews: scored.reviews,
      hiringRatio: scored.workforce,
      reposts: scored.reposts
    },
    cached: false
  });
  await flush();

  assert.match(scoredPage.panel.innerHTML, /class="number"/);
  assert.doesNotMatch(scoredPage.panel.innerHTML, /Not enough data to score/);
  assert.match(scoredPage.panel.innerHTML, /No duplicate found/);
});

test('a full check that finishes after switching jobs is kept and shown on coming back', async () => {
  const page = loadWidget();

  await page.widget.analyze(jobA);
  page.click('ghd-full');
  await flush();
  assert.equal(page.sent.length, 1);
  assert.equal(page.sent[0].body.jobId, '101');

  await page.widget.analyze(jobB);
  const jobBPanel = page.panel.innerHTML;
  assert.match(jobBPanel, /Run full check/);

  // Job A's result arrives while job B is on screen: B's panel is left alone.
  page.reply(0, remoteAnalysis(4.1));
  await flush();
  assert.equal(page.panel.innerHTML, jobBPanel);

  // Back on job A, its finished check is shown instead of a fresh button.
  await page.widget.analyze(jobA);
  assert.doesNotMatch(page.panel.innerHTML, /Run full check/);
  assert.ok(page.panel.innerHTML.includes('4.1 / 5 on Glassdoor'));
});

test('the T-Mobile repost row counts matches and links each earlier posting', async () => {
  const page = loadWidget();
  const earlier = 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4460918631';
  const second = 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4400000001';
  const job = {
    jobId: '4474577888',
    title: 'Senior Data Science Engineer',
    company: 'T-Mobile',
    description,
    postedLabel: '5 hours ago',
    url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4474577888'
  };

  await page.widget.analyze(job);
  page.click('ghd-full');
  await flush();
  page.reply(0, {
    ghostScore: 44,
    label: 'Ghost Job: Possible',
    factors: {
      vagueness: { score: 0, label: 'Clear' },
      layoffs: { detected: false, unavailable: false, score: 0 },
      reviews: { rating: 3.6, platform: 'Glassdoor', score: 4, unavailable: false },
      hiringRatio: { available: true, score: 0, ratio: 0.07, employees: 38000, openRoles: 2743 },
      reposts: {
        score: 40,
        count: 3,
        available: true,
        unavailable: false,
        dates: ['Date not shown', 'Date not shown', '1 day ago'],
        matches: [
          { url: job.url, dateLabel: 'Date not shown' },
          { url: earlier, dateLabel: 'Date not shown' },
          { url: second, dateLabel: 'Date not shown' }
        ],
        detail: 'should not be reused'
      }
    },
    cached: false
  });
  await flush();

  const html = page.panel.innerHTML;

  assert.match(html, /2 other postings/);
  assert.doesNotMatch(html, /3 other postings/);
  assert.match(html, /2 LinkedIn postings match this title, company, and location\./);
  assert.equal((html.match(/date not shown/g) || []).length, 2);
  assert.doesNotMatch(html, /4474577888/);
  assert.match(html, new RegExp(`href="${earlier}"[^>]*>source</a>, date not shown <a href="${second}"`));
  assert.match(html, /title="This posting may have been removed\."/);
  assert.doesNotMatch(html, /5 hours ago/);
  assert.doesNotMatch(html, />This posting may have been removed/);
});

test('returning to a job whose check is still running shows it as checking', async () => {
  const page = loadWidget();

  await page.widget.analyze(jobA);
  page.click('ghd-full');
  await flush();
  await page.widget.analyze(jobB);
  await page.widget.analyze(jobA);

  assert.match(page.panel.innerHTML, /Checking…/);
  assert.doesNotMatch(page.panel.innerHTML, /Run full check/);

  page.reply(0, remoteAnalysis(3.7));
  await flush();
  assert.ok(page.panel.innerHTML.includes('3.7 / 5 on Glassdoor'));
});
