import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { hasScoreEvidence as serverEvidence } from '../lib/server/score.js';

const sandbox = { console: { info() {}, warn() {}, log() {} } };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL('../lib/heuristics.js', import.meta.url), 'utf8'), sandbox);

const cases = [
  {
    name: 'no rating, size, repost, or layoff',
    input: {
      layoff: { detected: false, unavailable: false, source: 'newsdata' },
      reviews: { rating: null, reviewCount: null },
      workforce: { label: 'Unavailable', glassdoorSize: '' },
      reposts: { score: 0, unavailable: false }
    },
    expected: false
  },
  {
    name: 'a rating with fewer than five reviews',
    input: {
      reviews: { rating: 4.2, reviewCount: 4 },
      workforce: { label: 'Unknown', glassdoorSize: 'Unknown' }
    },
    expected: false
  },
  {
    name: 'a rating with five reviews',
    input: { reviews: { rating: 3.6, reviewCount: 5 } },
    expected: true
  },
  {
    name: 'a Glassdoor size bucket',
    input: { workforce: { label: '501 to 1000 Employees', glassdoorSize: '501 to 1000 Employees', employees: null } },
    expected: true
  },
  {
    name: 'a confirmed repost',
    input: { reposts: { score: 15, unavailable: false } },
    expected: true
  },
  {
    name: 'a finished repost check with no match',
    input: { reposts: { score: 0, unavailable: false, available: true } },
    expected: false
  },
  {
    name: 'a layoff from an accepted source',
    input: { layoff: { detected: true, source: 'layoffs.fyi', score: 25 } },
    expected: true
  },
  {
    name: 'a detected layoff with no accepted source',
    input: { layoff: { detected: true, source: null, score: 25 } },
    expected: false
  }
];

test('the client and server agree when a score has positive evidence', () => {
  const clientEvidence = sandbox.window.GhostJobHeuristics.hasScoreEvidence;

  for (const item of cases) {
    assert.equal(clientEvidence(item.input), item.expected, item.name);
    assert.equal(serverEvidence(item.input), item.expected, item.name);
  }
});
