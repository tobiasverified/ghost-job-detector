import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// A small stand-in for the page: the panel's HTML is kept as a string, and
// buttons found by id can be clicked from the test.
function loadWidget({ holdPay = false, sendError = null, trackTeardown = false } = {}) {
  const handlers = new Map();
  const panel = { innerHTML: '' };
  const stored = {};
  const sent = [];
  const pendingReplies = [];
  const reported = [];

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
    attrs: {},
    isConnected: false,
    removals: 0,
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    getAttribute(name) {
      return this.attrs[name] || null;
    },
    attachShadow() {
      return shadow;
    },
    addEventListener() {},
    remove() {
      this.removals += 1;
      this.isConnected = false;
    }
  };
  const sandbox = {
    URL,
    console: {
      ...console,
      info() {},
      error(...args) {
        if (!sendError) {
          console.error(...args);
          return;
        }

        reported.push(args.map((item) => item?.message || String(item)).join(' '));
      }
    },
    performance,
    setTimeout,
    clearTimeout,
    setInterval(fn, delay, ...args) {
      const timer = global.setInterval(fn, delay, ...args);
      timer.unref?.();
      return timer;
    },
    clearInterval(timer) {
      global.clearInterval(timer);
    },
    document: {
      createElement(tag) {
        return tag === 'div' && !host.isConnected && !host.created
          ? Object.assign(host, { created: true })
          : {
            tag,
            className: '',
            textContent: '',
            style: {},
            setAttribute() {},
            getAttribute() {
              return null;
            }
          };
      },
      documentElement: {
        appendChild(node) {
          node.isConnected = true;
        }
      },
      querySelectorAll(selector) {
        if (!host.isConnected) {
          return [];
        }

        const text = String(selector);
        const owned = host.getAttribute('data-ghd-instance');
        const ownInstance = owned && text.includes(`[data-ghd-instance="${owned}"]`);

        if (ownInstance || (trackTeardown && (text === '#ghd-widget-host' || text.includes('#ghd-widget-host')))) {
          return [host];
        }

        return [];
      }
    },
    chrome: {
      storage: {
        local: {
          get: async (keys) => {
            const names = Array.isArray(keys) ? keys : [keys];
            const result = {};

            for (const name of names) {
              if (Object.prototype.hasOwnProperty.call(stored, name)) {
                result[name] = stored[name];
              }
            }

            return result;
          },
          set: async (items) => {
            Object.assign(stored, items);
          }
        }
      },
      runtime: {
        id: 'ghost-job-detector',
        sendMessage(message) {
          sent.push(message);

          if (sendError && message.type === 'ENRICH_JOB') {
            return Promise.reject(sendError);
          }

          if (sendError || (message.type === 'PAY_MARKET' && !holdPay)) {
            return Promise.resolve({ ok: false });
          }

          return new Promise((resolve) => pendingReplies.push(resolve));
        }
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../lib/heuristics.js', import.meta.url), 'utf8'), sandbox);
  vm.runInContext(readFileSync(new URL('../lib/pay.js', import.meta.url), 'utf8'), sandbox);
  vm.runInContext(readFileSync(new URL('../lib/widget.js', import.meta.url), 'utf8'), sandbox);

  return {
    widget: sandbox.GhdWidget,
    heuristics: sandbox.GhostJobHeuristics,
    panel,
    sent,
    host,
    reported,
    click(id) {
      const handler = handlers.get(id);
      assert.ok(handler, `no ${id} button on the panel`);
      handler();
    },
    reply(index, analysis) {
      pendingReplies[index]({ ok: true, analysis, pay: analysis });
    },
    fail(index) {
      pendingReplies[index]({ ok: false });
    }
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const description = 'You will build Python services with 5 years of experience. Salary $150,000. Specific duties are listed for each quarter.';
const jobA = { jobId: '101', title: 'Analyst', company: 'Acme', description, url: 'https://www.linkedin.com/jobs/view/101' };
const jobB = { jobId: '202', title: 'Engineer', company: 'Initech', description, url: 'https://www.linkedin.com/jobs/view/202' };

function payAnalysis(rating = 4.2) {
  return { ...remoteAnalysis(rating), payCompareEnabled: true };
}

function remoteAnalysis(rating) {
  return {
    ghostScore: 10,
    label: 'Ghost Job: Not detected',
    factors: {
      layoffs: { detected: false, unavailable: false, score: 0 },
      reviews: { rating, platform: 'Glassdoor', score: 0, unavailable: false },
      reposts: { score: 0, unavailable: false },
      hiringRatio: { available: false, score: 0, label: '10,001+ Employees', glassdoorSize: '10,001+ Employees' }
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
    reviews: { rating: 3.6, reviewCount: 5, unavailable: false, score: 4, platform: 'Glassdoor' },
    workforce: { available: false, employees: null, score: 0 },
    reposts: { unavailable: false, available: true, score: 0, detail: 'No other LinkedIn posting matched this role.' }
  };

  assert.equal(page.heuristics.informativeFactorCount(blank), 1);
  assert.equal(page.heuristics.informativeFactorCount(scored), 2);
  assert.equal(page.heuristics.informativeFactorCount({
    layoff: { unavailable: true },
    reviews: { rating: 4.2, reviewCount: 3, unavailable: false, score: 0 },
    workforce: { available: false, employees: null, score: 0 },
    reposts: { unavailable: false, available: true, score: 0 }
  }), 1);
  assert.equal(page.heuristics.informativeFactorCount({
    layoff: { unavailable: true },
    reviews: { rating: 4.2, reviewCount: 5, unavailable: false, score: 0 },
    workforce: { available: false, employees: null, score: 0 },
    reposts: { unavailable: true }
  }), 1);

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
    label: 'Ghost Job: Not detected',
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

  assert.match(page.panel.innerHTML, /Checking\.\.\./);
  assert.match(page.panel.innerHTML, /No recent coverage/);
  assert.doesNotMatch(page.panel.innerHTML, /class="number"/);
  assert.doesNotMatch(page.panel.innerHTML, /Not enough data to score/);

  page.reply(1, {
    factors: { reposts: blank.reposts }
  });
  await flush();

  const withheld = page.panel.innerHTML;
  assert.match(withheld, /Not enough data to score/);
  assert.doesNotMatch(withheld, /class="number"/);
  assert.doesNotMatch(withheld, /stroke-dasharray/);
  assert.doesNotMatch(withheld, /Not detected|Unlikely/);
  assert.match(withheld, /No recent coverage/);
  assert.match(withheld, /No public reviews found/);
  assert.match(withheld, />Unavailable</);

  const scoredPage = loadWidget();
  await scoredPage.widget.analyze(jobA);
  scoredPage.click('ghd-full');
  await flush();
  scoredPage.reply(0, {
    ghostScore: 4,
    label: 'Ghost Job: Not detected',
    factors: {
      vagueness: { score: 0, label: 'Clear' },
      layoffs: scored.layoff,
      reviews: scored.reviews,
      hiringRatio: scored.workforce,
      reposts: { pending: true, score: 0, unavailable: true, available: false }
    },
    cached: false
  });
  await flush();
  assert.match(scoredPage.panel.innerHTML, /Checking\.\.\./);
  assert.doesNotMatch(scoredPage.panel.innerHTML, /class="number"/);
  scoredPage.reply(1, { factors: { reposts: scored.reposts } });
  await flush();

  assert.match(scoredPage.panel.innerHTML, /class="number"/);
  assert.doesNotMatch(scoredPage.panel.innerHTML, /Not enough data to score/);
  assert.match(scoredPage.panel.innerHTML, /No duplicate found/);
  assert.doesNotMatch(scoredPage.panel.innerHTML, /Some checks took too long/);
  assert.doesNotMatch(scoredPage.panel.innerHTML, /id="ghd-retry"/);
});

test('a withheld response shows no score and keeps finished rows for a retry', async () => {
  const page = loadWidget();
  const detail = 'Still finishing. Try again in a few seconds.';
  const withheldBody = {
    ghostScore: null,
    label: null,
    scoreWithheld: true,
    partial: true,
    factors: {
      vagueness: { score: 0, label: 'Clear' },
      layoffs: { detected: false, unavailable: true, timedOut: true, score: 0, detail },
      reviews: { rating: 4.1, platform: 'Glassdoor', score: 8, unavailable: false },
      hiringRatio: { available: true, employees: 100, openRoles: 4, ratio: 0.04, score: 0 },
      reposts: { pending: true, score: 0, unavailable: true, available: false }
    }
  };

  await page.widget.analyze(jobA);
  page.click('ghd-full');
  await flush();
  page.reply(0, withheldBody);
  await flush();
  page.reply(1, {
    factors: { reposts: { score: 40, unavailable: false, available: true, matches: [] } }
  });
  await flush();

  const withheld = page.panel.innerHTML;
  assert.match(withheld, /Some checks took too long/);
  assert.match(withheld, /id="ghd-retry"/);
  assert.match(withheld, /4\.1 \/ 5 on Glassdoor/);
  assert.match(withheld, /Check unavailable/);
  assert.match(withheld, new RegExp(detail.replace(/[.]/g, '\\.')));
  assert.doesNotMatch(withheld, /class="number"/);
  assert.doesNotMatch(withheld, /stroke-dasharray/);
  assert.doesNotMatch(withheld, /Not enough data to score/);
  assert.doesNotMatch(withheld, /Finishing checks/);
  assert.equal(page.sent.filter((message) => message.type === 'ENRICH_JOB').length, 1);

  page.click('ghd-retry');
  await flush();
  assert.match(page.panel.innerHTML, /4\.1 \/ 5 on Glassdoor/);
  assert.match(page.panel.innerHTML, /Still finishing/);
  assert.equal(page.sent.filter((message) => message.type === 'ENRICH_JOB').length, 2);
  assert.equal(page.sent.filter((message) => message.type === 'ENRICH_JOB')[1].body.refresh, true);

  page.reply(2, {
    ghostScore: 4,
    label: 'Ghost Job: Not detected',
    factors: {
      vagueness: { score: 0, label: 'Clear' },
      layoffs: { unavailable: false, detected: false, score: 0 },
      reviews: { rating: 4.1, reviewCount: 5, platform: 'Glassdoor', score: 0, unavailable: false },
      hiringRatio: { available: false, score: 0 },
      reposts: { pending: true, score: 0, unavailable: true, available: false }
    }
  });
  await flush();
  page.reply(3, {
    factors: { reposts: { unavailable: false, available: true, score: 0, detail: 'No other LinkedIn posting matched this role.' } }
  });
  await flush();

  assert.match(page.panel.innerHTML, /class="number"/);
  assert.doesNotMatch(page.panel.innerHTML, /Some checks took too long/);
  assert.doesNotMatch(page.panel.innerHTML, /id="ghd-retry"/);
});

test('a partial check shows the server score and unfinished rows, with no automatic retry', async () => {
  const page = loadWidget();
  const detail = 'Still checking, try again in a few seconds';
  const partialBody = {
    ghostScore: 37,
    label: 'Ghost Job: Possible',
    partial: true,
    factors: {
      vagueness: { score: 30, label: 'Very Vague' },
      layoffs: { detected: false, unavailable: false, score: 0 },
      reviews: { rating: 4.1, reviewCount: 5, platform: 'Glassdoor', score: 15, unavailable: false },
      hiringRatio: { available: false, timedOut: true, score: 0, detail },
      reposts: { pending: true, score: 0, unavailable: true, available: false }
    }
  };

  await page.widget.analyze(jobA);
  page.click('ghd-full');
  await flush();
  page.reply(0, partialBody);
  await flush();
  page.reply(1, {
    factors: { reposts: { unavailable: false, available: true, score: 0, detail: 'No other LinkedIn posting matched this role.' } }
  });
  await flush();

  assert.match(page.panel.innerHTML, /class="number">37</);
  assert.doesNotMatch(page.panel.innerHTML, /class="number">45</);
  assert.match(page.panel.innerHTML, /Still checking, try again in a few seconds/);
  assert.match(page.panel.innerHTML, /id="ghd-retry"/);
  assert.match(page.panel.innerHTML, /4\.1 \/ 5 on Glassdoor/);
  assert.doesNotMatch(page.panel.innerHTML, /Finishing checks/);
  assert.doesNotMatch(page.panel.innerHTML, /Checking\.\.\./);

  await wait(3200);
  await flush();
  const enrichments = page.sent.filter((message) => message.type === 'ENRICH_JOB');
  assert.equal(enrichments.length, 1);
  assert.equal(enrichments[0].body.refresh, undefined);

  page.click('ghd-retry');
  await flush();
  assert.equal(page.sent.filter((message) => message.type === 'ENRICH_JOB').length, 2);
  assert.equal(page.sent.filter((message) => message.type === 'ENRICH_JOB')[1].body.refresh, true);
  page.reply(2, partialBody);
  await flush();
  page.reply(3, {
    factors: { reposts: { unavailable: false, available: true, score: 0, detail: 'No other LinkedIn posting matched this role.' } }
  });
  await flush();
  assert.match(page.panel.innerHTML, /class="number">37</);
  assert.match(page.panel.innerHTML, /Still checking, try again in a few seconds/);
});

test('a partial check stays on its job and does not retry on its own', async () => {
  const page = loadWidget();

  await page.widget.analyze(jobA);
  page.click('ghd-full');
  await flush();
  page.reply(0, {
    ghostScore: 37,
    label: 'Ghost Job: Possible',
    partial: true,
    factors: {
      vagueness: { score: 0, label: 'Clear' },
      layoffs: { detected: false, unavailable: false, score: 0 },
      reviews: { rating: 4.1, reviewCount: 5, platform: 'Glassdoor', score: 0, unavailable: false },
      hiringRatio: { available: false, timedOut: true, score: 0, detail: 'Still finishing. Try again in a few seconds.' },
      reposts: { pending: true, score: 0, unavailable: true, available: false }
    }
  });
  await flush();
  page.reply(1, {
    factors: { reposts: { unavailable: false, available: true, score: 0, detail: 'No duplicate found' } }
  });
  await flush();
  assert.match(page.panel.innerHTML, /class="number">37</);
  assert.match(page.panel.innerHTML, /Still checking, try again in a few seconds/);

  await page.widget.analyze(jobB);
  await flush();
  assert.doesNotMatch(page.panel.innerHTML, /class="number">37</);
  assert.doesNotMatch(page.panel.innerHTML, /Still checking, try again in a few seconds/);

  await wait(3200);
  await flush();
  assert.equal(page.sent.filter((message) => message.type === 'ENRICH_JOB').length, 1);

  await page.widget.analyze(jobA);
  await flush();
  assert.match(page.panel.innerHTML, /class="number">37</);
  assert.match(page.panel.innerHTML, /Still checking, try again in a few seconds/);
  assert.match(page.panel.innerHTML, /id="ghd-retry"/);
  assert.equal(page.sent.filter((message) => message.type === 'ENRICH_JOB').length, 1);
});

test('a Workday check sends the resolved company name', async () => {
  const page = loadWidget();
  const job = {
    title: 'AI Operations Engineer',
    company: 'Argonne',
    description,
    platform: 'WORKDAY',
    url: 'https://argonne.wd1.myworkdayjobs.com/en-US/Argonne_Careers/job/Lemont-IL/AI-Operations-Engineer_423470'
  };

  await page.widget.analyze(job);
  let settle;
  page.widget.trackIdentity(new Promise((resolve) => {
    settle = resolve;
  }));
  page.click('ghd-full');
  settle({ ready: true, company: 'Argonne National Laboratory' });
  await flush();

  assert.equal(page.sent[0].type, 'ENRICH_JOB');
  assert.equal(page.sent[0].body.company, 'Argonne National Laboratory');
  assert.equal(page.sent[1].type, 'REPOST_JOB');
  assert.equal(page.sent[1].body.company, 'Argonne National Laboratory');
  page.reply(0, remoteAnalysis(4.3));
  page.reply(1, remoteAnalysis(4.3));
  await flush();
});

test('a Discord vendor listing shows the careers line and Cloudflare Egress does not', async () => {
  const notice = {
    show: true,
    text: '⚠️ Not found on the company\'s careers board',
    tooltip: 'Checked Greenhouse board, 84 jobs'
  };
  const discord = loadWidget();
  const vendor = {
    jobId: 'discord-vendor',
    title: 'Java Developer',
    company: 'Discord',
    description,
    url: 'https://www.linkedin.com/jobs/view/discord-vendor'
  };

  await discord.widget.analyze(vendor);
  discord.click('ghd-full');
  await flush();
  discord.reply(0, { ...remoteAnalysis(4), careers: notice, careersChecked: true });
  discord.reply(1, remoteAnalysis(4));
  await flush();

  const shown = discord.panel.innerHTML;
  const repostsAt = shown.indexOf('Reposts');
  const lineAt = shown.indexOf('⚠️ Not found on the company\'s careers board');

  assert.ok(repostsAt > -1);
  assert.ok(lineAt > repostsAt);
  assert.match(shown, /title="Checked Greenhouse board, 84 jobs"/);
  assert.equal(discord.sent.some((message) => message.type === 'CAREERS_JOB'), false);

  const cloudflare = loadWidget();
  await cloudflare.widget.analyze({
    jobId: 'cf-egress',
    title: 'Software Engineer - Egress (Go/Rust)',
    company: 'Cloudflare',
    description,
    url: 'https://www.linkedin.com/jobs/view/cloudflare-egress'
  });
  cloudflare.click('ghd-full');
  await flush();
  cloudflare.reply(0, { ...remoteAnalysis(4), careers: null, careersChecked: true });
  cloudflare.reply(1, remoteAnalysis(4));
  await flush();

  assert.doesNotMatch(cloudflare.panel.innerHTML, /Not found on the company's careers board/);
  assert.equal(cloudflare.sent.some((message) => message.type === 'CAREERS_JOB'), false);
  assert.equal(
    shown.match(/class="number">(\d+)/)?.[1],
    cloudflare.panel.innerHTML.match(/class="number">(\d+)/)?.[1]
  );
});

test('the careers line is requested after the card renders when the board was not checked', async () => {
  const page = loadWidget();
  const notice = {
    show: true,
    text: '⚠️ Not found on the company\'s careers board',
    tooltip: 'Checked Greenhouse board, 84 jobs'
  };

  await page.widget.analyze({
    jobId: 'discord-later',
    title: 'Java Developer',
    company: 'Discord',
    description,
    url: 'https://www.linkedin.com/jobs/view/discord-later'
  });
  page.click('ghd-full');
  await flush();
  page.reply(0, { ...remoteAnalysis(4), careersChecked: false });
  page.reply(1, remoteAnalysis(4));
  await flush();

  assert.equal(page.sent[2]?.type, 'CAREERS_JOB');
  assert.equal(page.sent[2].body.title, 'Java Developer');
  assert.equal(page.sent[2].body.company, 'Discord');
  assert.doesNotMatch(page.panel.innerHTML, /Not found on the company's careers board/);

  page.reply(2, notice);
  await flush();

  assert.match(page.panel.innerHTML, /Not found on the company's careers board/);
  assert.match(page.panel.innerHTML, /title="Checked Greenhouse board, 84 jobs"/);
});

test('a full check that finishes after switching jobs is kept and shown on coming back', async () => {
  const page = loadWidget();

  await page.widget.analyze(jobA);
  page.click('ghd-full');
  await flush();
  assert.equal(page.sent.length, 2);
  assert.equal(page.sent[0].type, 'ENRICH_JOB');
  assert.equal(page.sent[0].body.deferReposts, true);
  assert.equal(page.sent[0].body.jobId, '101');
  assert.equal(page.sent[1].type, 'REPOST_JOB');
  assert.equal(page.sent[1].body.jobId, '101');

  await page.widget.analyze(jobB);
  const jobBPanel = page.panel.innerHTML;
  assert.match(jobBPanel, /Run full check/);

  // Job A's result arrives while job B is on screen: B's panel is left alone.
  page.reply(0, remoteAnalysis(4.1));
  page.reply(1, remoteAnalysis(4.1));
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
  const reposts = {
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
  };
  page.reply(0, {
    ghostScore: 4,
    label: 'Ghost Job: Not detected',
    factors: {
      vagueness: { score: 0, label: 'Clear' },
      layoffs: { detected: false, unavailable: false, score: 0 },
      reviews: { rating: 3.6, platform: 'Glassdoor', score: 4, unavailable: false },
      hiringRatio: { available: true, score: 0, ratio: 0.07, employees: 38000, openRoles: 2743 },
      reposts: { pending: true, score: 0, unavailable: true, available: false }
    },
    cached: false
  });
  await flush();
  assert.match(page.panel.innerHTML, /Checking\.\.\./);
  assert.doesNotMatch(page.panel.innerHTML, /class="number"/);
  page.reply(1, { factors: { reposts } });
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

test('hide stays collapsed when another job is selected and checked', async () => {
  const page = loadWidget();

  await page.widget.analyze(jobA);
  assert.match(page.panel.innerHTML, />Hide</);
  page.click('ghd-expand');
  assert.match(page.panel.innerHTML, />Expand</);
  assert.doesNotMatch(page.panel.innerHTML, /Description Clarity/);

  await page.widget.analyze(jobB);
  assert.match(page.panel.innerHTML, />Expand</);
  assert.doesNotMatch(page.panel.innerHTML, /Description Clarity/);

  page.click('ghd-full');
  await flush();
  page.reply(0, remoteAnalysis(4));
  page.reply(1, remoteAnalysis(4));
  await flush();

  assert.match(page.panel.innerHTML, />Expand</);
  assert.doesNotMatch(page.panel.innerHTML, /Description Clarity/);
  page.click('ghd-expand');
  assert.match(page.panel.innerHTML, />Hide</);
  assert.match(page.panel.innerHTML, /Description Clarity/);
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
  page.reply(1, remoteAnalysis(3.7));
  await flush();
  assert.ok(page.panel.innerHTML.includes('3.7 / 5 on Glassdoor'));
});

test('the review row shows a count only when the payload has one', async () => {
  const counted = loadWidget();
  await counted.widget.analyze(jobA);
  counted.click('ghd-full');
  await flush();
  const payload = remoteAnalysis(3.7);
  payload.factors.reviews = {
    rating: 3.7,
    platform: 'Glassdoor',
    score: 4,
    unavailable: false,
    reviewCount: 43
  };
  counted.reply(0, payload);
  counted.reply(1, payload);
  await flush();
  assert.match(counted.panel.innerHTML, /3\.7 \/ 5 on Glassdoor \(43 reviews\)/);
  assert.doesNotMatch(counted.panel.innerHTML, /0 reviews/);

  const alone = loadWidget();
  await alone.widget.analyze(jobA);
  alone.click('ghd-full');
  await flush();
  alone.reply(0, remoteAnalysis(3.7));
  alone.reply(1, remoteAnalysis(3.7));
  await flush();
  assert.match(alone.panel.innerHTML, /3\.7 \/ 5 on Glassdoor(?! \(43 reviews\))/);
  assert.doesNotMatch(alone.panel.innerHTML, /\(\d+ reviews\)/);

  const blank = loadWidget();
  const row = blank.heuristics.buildFactors(
    { label: 'Clear', score: 0 },
    { detected: false, unavailable: false, score: 0 },
    { available: false, score: 0 },
    { rating: 3.7, platform: 'Glassdoor', score: 4, unavailable: false, reviewCount: 0 },
    { score: 0, unavailable: false }
  ).find((factor) => factor.label === 'Company Reviews');
  assert.equal(row.value, '3.7 / 5 on Glassdoor');
});

const payDescription = 'You will build Python services with 5 years of experience. Specific duties are listed for each quarter of the year.';

function payJob(extra) {
  return {
    jobId: 'pay-job',
    title: 'Data Scientist',
    company: 'Northwind',
    description: payDescription,
    url: 'https://www.linkedin.com/jobs/view/pay-job',
    locationNormalized: 'Hartford, CT',
    ...extra
  };
}

async function finishCheck(page, body = remoteAnalysis(4.2)) {
  page.click('ghd-full');
  await flush();
  page.reply(0, body);
  await flush();
  page.reply(1, body);
  await flush();
}

test('pay vs market stays on the posted range until the comparison returns', async () => {
  const missing = loadWidget({ holdPay: true });
  await missing.widget.analyze(payJob({ jobId: 'no-pay', salary: '' }));
  assert.doesNotMatch(missing.panel.innerHTML, /Pay vs market/);
  await finishCheck(missing);
  assert.equal(missing.sent.some((message) => message.type === 'PAY_MARKET'), false);
  assert.doesNotMatch(missing.panel.innerHTML, /Pay vs market/);

  const unnamed = loadWidget({ holdPay: true });
  await unnamed.widget.analyze(payJob({ jobId: 'flag-no-pay', salary: '' }));
  await finishCheck(unnamed, payAnalysis());
  assert.equal(unnamed.sent.some((message) => message.type === 'PAY_MARKET'), false);
  assert.match(unnamed.panel.innerHTML, /Salary not listed/);

  const listed = loadWidget({ holdPay: true });
  await listed.widget.analyze(payJob({ salary: '$130k - $160k' }));
  assert.doesNotMatch(listed.panel.innerHTML, /Pay vs market/);
  assert.equal(listed.sent.some((message) => message.type === 'PAY_MARKET'), false);

  listed.click('ghd-full');
  await flush();
  assert.equal(listed.sent.some((message) => message.type === 'PAY_MARKET'), false);
  listed.reply(0, payAnalysis());
  await flush();

  const payMessage = listed.sent.find((message) => message.type === 'PAY_MARKET');
  assert.equal(payMessage.body.title, 'Data Scientist');
  assert.equal(payMessage.body.locationNormalized, 'Hartford, CT');
  assert.equal(payMessage.body.salary, '$130k - $160k');
  assert.match(listed.panel.innerHTML, /Listed \$130-160K/);
  assert.doesNotMatch(listed.panel.innerHTML, /Market median/);

  listed.reply(1, payAnalysis());
  await flush();
  const before = listed.panel.innerHTML.match(/class="number">(\d+)/)?.[1];
  listed.reply(2, {
    compared: true,
    text: 'Listed $130-160K · Market median $142K for this title in Hartford (80 reports)',
    note: 'within the range'
  });
  await flush();

  assert.match(listed.panel.innerHTML, /Listed \$130-160K · Market median \$142K for this title in Hartford \(80 reports\)/);
  assert.match(listed.panel.innerHTML, /within the range/);
  assert.equal(listed.panel.innerHTML.match(/class="number">(\d+)/)?.[1], before);

  const failed = loadWidget({ holdPay: true });
  await failed.widget.analyze(payJob({ jobId: 'pay-fail', salary: '$130,000 - $160,000' }));
  await finishCheck(failed, payAnalysis());
  failed.fail(2);
  await flush();
  assert.match(failed.panel.innerHTML, /Listed \$130-160K/);
  assert.doesNotMatch(failed.panel.innerHTML, /Market median/);
});

test('pay vs market uses the three placement phrases and keeps each job separate', async () => {
  const phrases = [
    ['$80,000', 'below the 25th percentile'],
    ['$130,000 - $160,000', 'within the range'],
    ['$200,000', 'above the 75th']
  ];

  for (const [salary, note] of phrases) {
    const page = loadWidget({ holdPay: true });
    await page.widget.analyze(payJob({ jobId: note, salary }));
    await finishCheck(page, payAnalysis());
    page.reply(2, {
      compared: true,
      text: `Listed pay · Market median $142K for this title in Hartford (80 reports)`,
      note
    });
    await flush();
    assert.match(page.panel.innerHTML, new RegExp(note.replace(/[.]/g, '\\.')));
  }

  const page = loadWidget({ holdPay: true });
  const first = payJob({
    jobId: 'job-a',
    company: 'Northwind',
    salary: '$200,000',
    url: 'https://www.linkedin.com/jobs/view/job-a'
  });
  const second = payJob({
    jobId: 'job-b',
    company: 'Contoso',
    salary: '',
    url: 'https://www.linkedin.com/jobs/view/job-b'
  });

  await page.widget.analyze(first);
  await finishCheck(page, payAnalysis());
  page.reply(2, {
    compared: true,
    text: 'Listed $200K · Market median $142K for this title in Hartford (80 reports)',
    note: 'above the 75th'
  });
  await flush();
  assert.match(page.panel.innerHTML, /above the 75th/);

  await page.widget.analyze(second);
  await flush();
  assert.doesNotMatch(page.panel.innerHTML, /Pay vs market/);
  assert.doesNotMatch(page.panel.innerHTML, /above the 75th/);
  assert.equal(page.sent.filter((message) => message.type === 'PAY_MARKET').length, 1);

  await page.widget.analyze(first);
  await flush();
  assert.match(page.panel.innerHTML, /above the 75th/);
  assert.match(page.panel.innerHTML, /Listed \$200K · Market median \$142K/);
});

test('a seniority title without stated years keeps the posted pay and does not ask for a market estimate', async () => {
  const page = loadWidget({ holdPay: true });

  await page.widget.analyze(payJob({
    jobId: 'senior-pay',
    title: 'Senior Data Scientist',
    salary: '$130k - $160k',
    description: 'You will build Python services. Specific duties are listed for each quarter of the year.'
  }));
  await finishCheck(page, payAnalysis());

  assert.match(page.panel.innerHTML, /Listed \$130-160K/);
  assert.doesNotMatch(page.panel.innerHTML, /Market median/);
  assert.equal(page.sent.some((message) => message.type === 'PAY_MARKET'), false);

  const stated = loadWidget({ holdPay: true });

  await stated.widget.analyze(payJob({
    jobId: 'years-pay',
    salary: '$130k - $160k'
  }));
  await finishCheck(stated, payAnalysis());

  const message = stated.sent.find((item) => item.type === 'PAY_MARKET');
  assert.equal(message.body.description.includes('5 years of experience'), true);
  stated.reply(2, { compared: false });
  await flush();
});

test('an invalidated sendMessage tears the widget down once and throws nothing', async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);

  try {
    const page = loadWidget({
      sendError: new Error('Extension context invalidated'),
      trackTeardown: true
    });

    await page.widget.analyze(jobA);
    page.click('ghd-full');
    await flush();
    await flush();

    assert.equal(unhandled.length, 0);
    assert.equal(page.host.removals, 1);
    assert.equal(page.host.isConnected, false);
    assert.equal(page.reported.some((line) => /extension context invalidated/i.test(line)), false);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a sendMessage error other than an invalidated context is still reported', async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);

  try {
    const page = loadWidget({
      sendError: new Error('receiver missing'),
      trackTeardown: true
    });

    await page.widget.analyze(jobA);
    page.click('ghd-full');
    await flush();
    await flush();

    assert.equal(page.host.removals, 0);
    assert.equal(page.host.isConnected, true);
    assert.ok(page.reported.some((line) => line.includes('receiver missing')));
    assert.match(page.panel.innerHTML, /Full check unavailable/);
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
