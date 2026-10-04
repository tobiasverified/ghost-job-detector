import assert from 'node:assert/strict';
import test from 'node:test';
import { findCompanyReviews, parseReviewSnippet, pickReview } from '../lib/server/reviews.js';
import { parseDuckDuckGoHtml } from '../lib/server/search.js';

const GLASSDOOR_HTML = `
<div class="result__body">
  <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.glassdoor.com%2FReviews%2FAcme-Reviews-E123.htm&amp;rut=abc">Acme Reviews | Glassdoor</a>
  <a class="result__snippet" href="https://example.com">Rating 3.2 out of 5 stars, based on 1,240 reviews of Acme.</a>
</div>
<div class="result__body">
  <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.indeed.com%2Fcmp%2FAcme">Acme Careers</a>
  <a class="result__snippet" href="https://example.com">Rated 4.4 out of 5 from 300 reviews.</a>
</div>`;

test('DuckDuckGo HTML keeps Glassdoor ratings and unwraps redirect links', () => {
  const results = parseDuckDuckGoHtml(GLASSDOOR_HTML);
  const review = pickReview(results);

  assert.equal(results.length, 2);
  assert.equal(review.platform, 'Glassdoor');
  assert.equal(review.rating, 3.2);
  assert.equal(review.reviewCount, 1240);
  assert.equal(review.score, 10);
  assert.equal(review.url, 'https://www.glassdoor.com/Reviews/Acme-Reviews-E123.htm');
});

test('Axon ratings ignore a different company that shares the name', () => {
  const review = pickReview([
    {
      title: 'AXON-ACTIVE Reviews',
      snippet: 'Rating 3.4 out of 5 stars, based on 20 reviews of AXON-ACTIVE.',
      url: 'https://www.glassdoor.com/Reviews/AXON-ACTIVE-Reviews-E1063309.htm'
    },
    {
      title: 'Axon Reviews',
      snippet: 'Axon has an employee rating of 3.6 out of 5 stars, based on 778 company reviews on Glassdoor.',
      url: 'https://www.glassdoor.com/Reviews/Axon-Reviews-E1597674.htm'
    }
  ], 'Axon');

  assert.equal(review.rating, 3.6);
  assert.equal(review.reviewCount, 778);
  assert.equal(review.score, 4);
  assert.match(review.url, /Axon-Reviews-E1597674/);
});

test('Pearson reviews ignore the candy company', () => {
  const review = pickReview([
    {
      title: 'Pearson\'s Candy Company Reviews',
      snippet: 'Pearson\'s Candy Company has an employee rating of 3.1 out of 5 stars, based on 40 reviews.',
      url: 'https://www.glassdoor.com/Reviews/Pearsons-Candy-Company-Reviews-E1.htm'
    },
    {
      title: 'Pearson Reviews',
      snippet: 'Pearson has an employee rating of 3.7 out of 5 stars, based on 2,400 company reviews on Glassdoor.',
      url: 'https://www.glassdoor.com/Reviews/Pearson-Reviews-E5500.htm'
    }
  ], 'Pearson');

  assert.equal(review.rating, 3.7);
  assert.match(review.url, /Pearson-Reviews-E5500/);
});

test('AMLI Residential reviews require the full company name', () => {
  const review = pickReview([
    {
      title: 'AMLI Program Reviews',
      snippet: 'AMLI has an employee rating of 2.2 out of 5 stars, based on 15 reviews.',
      url: 'https://www.glassdoor.com/Reviews/AMLI-Program-Reviews-E9.htm'
    },
    {
      title: 'AMLI Residential Reviews',
      snippet: 'AMLI Residential has an employee rating of 3.9 out of 5 stars, based on 295 company reviews on Glassdoor.',
      url: 'https://www.glassdoor.com/Reviews/AMLI-Residential-Reviews-E2514.htm'
    }
  ], 'AMLI Residential');

  assert.equal(review.rating, 3.9);
  assert.equal(review.reviewCount, 295);
  assert.match(review.url, /AMLI-Residential-Reviews-E2514/);
});

test('AMLI Residential matches a Glassdoor page that only names AMLI', async () => {
  const queries = [];
  const review = await findCompanyReviews('AMLI Residential', {
    webSearch: async (query) => {
      queries.push(query);

      if (query !== '"AMLI Residential" reviews') {
        return [];
      }

      return [
        {
          title: 'AMLI Reviews',
          snippet: 'AMLI has an employee rating of 3.9 out of 5 stars, based on 295 company reviews.',
          url: 'https://www.glassdoor.com/Reviews/AMLI-Reviews-E2514.htm'
        }
      ];
    }
  });

  assert.deepEqual(queries, ['"AMLI Residential" reviews']);
  assert.equal(review.rating, 3.9);
  assert.equal(review.reviewCount, 295);
  assert.equal(review.platform, 'Glassdoor');
  assert.equal(review.unavailable, false);
  assert.match(review.url, /AMLI-Reviews-E2514/);
});

test('a missed full-name review search retries the shorter alias', async () => {
  const queries = [];
  const review = await findCompanyReviews('AMLI Residential', {
    webSearch: async (query) => {
      queries.push(query);

      if (query !== '"amli" reviews') {
        return [];
      }

      return [
        {
          title: 'AMLI Reviews',
          snippet: 'AMLI has an employee rating of 3.9 out of 5 stars, based on 295 company reviews.',
          url: 'https://www.glassdoor.com/Reviews/AMLI-Reviews-E2514.htm'
        }
      ];
    }
  });

  assert.deepEqual(queries, ['"AMLI Residential" reviews', '"amli" reviews']);
  assert.equal(review.rating, 3.9);
  assert.equal(review.platform, 'Glassdoor');
});

test('review parsing rejects ratings outside 1 to 5', () => {
  assert.equal(parseReviewSnippet({
    title: 'Acme',
    snippet: 'Rated 8.2 out of 5 by fans'
  }), null);
});

test('one review query prefers a Glassdoor rating in the same results', async () => {
  const queries = [];
  const review = await findCompanyReviews('Acme', {
    webSearch: async (query) => {
      queries.push(query);

      return [
        {
          title: 'Acme Reviews',
          snippet: '3.0 out of 5 from 220 reviews',
          url: 'https://www.indeed.com/cmp/Acme/reviews'
        },
        {
          title: 'Acme Reviews',
          snippet: '4.2 out of 5 from 100 reviews',
          url: 'https://www.glassdoor.com/Reviews/Acme-Reviews-E1.htm'
        }
      ];
    }
  });

  assert.deepEqual(queries, ['"Acme" reviews']);
  assert.equal(review.platform, 'Glassdoor');
  assert.equal(review.rating, 4.2);
  assert.equal(review.score, 0);
});

test('a search outage reports reviews as unavailable', async () => {
  const review = await findCompanyReviews('Acme', {
    webSearch: async () => {
      throw new Error('blocked');
    }
  });

  assert.equal(review.rating, null);
  assert.equal(review.score, 0);
  assert.equal(review.unavailable, false);
  assert.equal(review.detail, 'No public reviews found');
});

test('review snippets accept common rating formats', () => {
  assert.equal(parseReviewSnippet({
    title: 'Acme',
    snippet: 'Rated 3.8 out of 5 by employees'
  }).rating, 3.8);
  assert.equal(parseReviewSnippet({
    title: 'The Local',
    snippet: 'rated 4.1 of 5 on Tripadvisor'
  }).rating, 4.1);
  assert.equal(parseReviewSnippet({
    title: 'Starbucks Reviews',
    snippet: 'Rated 2.6/5'
  }).rating, 2.6);
  assert.equal(parseReviewSnippet({
    title: 'Joe\'s Pizza',
    snippet: 'Joe\'s Pizza has an average rating of 4.1 from 8835 reviews.'
  }).rating, 4.1);
  assert.equal(parseReviewSnippet({
    title: 'Diner',
    snippet: 'Customers left ★☆☆☆☆'
  }).rating, 1);
  assert.equal(parseReviewSnippet({
    title: 'Acme',
    snippet: 'Out of 647 Acme employee reviews, 85% were positive.'
  }), null);
});
