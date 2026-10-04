import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { MemoryCache } from '../lib/server/cache.js';
import { lookupCompanyRating } from '../lib/server/company-rating.js';
import { resolveWorkforce } from '../lib/server/analyze.js';

function loadHeadcount() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(new URL('../lib/company-headcount.js', import.meta.url), 'utf8'),
    sandbox
  );
  return sandbox.GhdHeadcount;
}

test('a Workday posting resolved to TKO Group Holdings finds the tkogroup capture', () => {
  const headcount = loadHeadcount();
  const now = Date.parse('2026-10-01T12:00:00Z');
  const stored = {
    [headcount.storageKey('tkogroup')]: {
      slug: 'tkogroup',
      employees: 12057,
      capturedAt: now
    }
  };
  const captured = headcount.freshHeadcount(
    stored,
    headcount.lookupSlugs('', 'TKO Group Holdings'),
    now
  );

  assert.equal(headcount.identitySlug('TKO Group Holdings'), 'tkogroupholdings');
  assert.equal(captured.employees, 12057);
  assert.equal(captured.slug, 'tkogroup');
  assert.equal(headcount.freshHeadcount(stored, headcount.lookupSlugs('', 'On Location'), now), null);
});

test('a resolved company slug uses the captured company-page count before search', async () => {
  const headcount = loadHeadcount();
  const now = Date.parse('2026-10-01T12:00:00Z');
  const slug = headcount.slugFromUrl('https://www.linkedin.com/company/tkogroup/about/');
  const stored = {
    [headcount.storageKey(slug)]: {
      slug,
      employees: headcount.readPageEmployees({
        querySelectorAll(selector) {
          if (selector === 'a[href*="/people"]') {
            return [{ textContent: 'View all 1,400 employees' }];
          }

          return [];
        }
      }),
      capturedAt: now
    }
  };
  const captured = headcount.freshHeadcount(
    stored,
    headcount.lookupSlugs(slug, 'TKO Group Holdings'),
    now
  );
  const missed = headcount.freshHeadcount(stored, headcount.lookupSlugs('other-co', 'Other Co'), now);
  const expired = headcount.freshHeadcount(stored, [slug], now + headcount.COMPANY_HEADCOUNT_TTL_MS + 1);
  let searches = 0;
  const rating = await lookupCompanyRating('TKO Group Holdings', {
    now: new Date(now),
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: 'test-key' },
    capturedHeadcount: captured,
    askGroq: async () => {
      searches += 1;
      throw new Error('search should not run');
    },
    findEmployeeCountBySearch: async () => {
      searches += 1;
      return { employees: 50, employeeLabel: '50', sourceUrl: 'https://example.com/tko' };
    },
    fetch: async (url) => {
      if (String(url).includes('wikidata.org')) {
        searches += 1;
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ratings: { overall: 3.4 },
            counts: { open_jobs: 12 }
          };
        }
      };
    }
  });
  const workforce = resolveWorkforce(rating);

  assert.equal(slug, 'tkogroup');
  assert.equal(captured.employees, 1400);
  const fromWorkday = headcount.freshHeadcount(
    stored,
    headcount.lookupSlugs('', 'TKO Group Holdings'),
    now
  );
  const otherIdentity = headcount.freshHeadcount(
    stored,
    headcount.lookupSlugs('', 'On Location'),
    now
  );
  assert.equal(fromWorkday.employees, 1400);
  assert.equal(fromWorkday.slug, 'tkogroup');
  assert.equal(otherIdentity, null);
  assert.deepEqual(
    [...headcount.captureKeys('tkogroup', 'TKO Group Holdings')],
    [headcount.storageKey('tkogroup'), headcount.storageKey('tkogroupholdings')]
  );
  assert.equal(missed, null);
  assert.equal(expired, null);
  assert.equal(rating.employees, 1400);
  assert.equal(rating.employeeSource, 'linkedin');
  assert.equal(rating.openJobs, 12);
  assert.equal(searches, 0);
  assert.equal(workforce.employees, 1400);
  assert.equal(workforce.openRoles, 12);
  assert.equal(workforce.estimated, false);
  assert.equal(workforce.employeeSource, 'linkedin');
});
