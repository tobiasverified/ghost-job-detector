import assert from 'node:assert/strict';
import test from 'node:test';
import { askGroq } from '../lib/server/groq-client.js';

test('askGroq returns the completion text and does not retry a failure', async () => {
  let calls = 0;
  const text = await askGroq('Name the employer.', {
    timeoutMs: 4000,
    temperature: 0,
    env: { GROQ_API_KEY: 'test-key' },
    fetch: async (url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      assert.equal(String(url), 'https://api.groq.com/openai/v1/chat/completions');
      assert.equal(body.model, 'openai/gpt-oss-120b');
      assert.equal(body.temperature, 0);
      assert.equal(body.messages[0].content, 'Name the employer.');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'TKO Group Holdings' } }] };
        }
      };
    }
  });

  assert.equal(text, 'TKO Group Holdings');
  assert.equal(calls, 1);

  await assert.rejects(() => askGroq('again', {
    env: { GROQ_API_KEY: 'test-key' },
    fetch: async () => {
      calls += 1;
      return { ok: false, status: 503, async json() { return {}; } };
    }
  }), /503/);
  assert.equal(calls, 2);
});

test('askGroq throws when the key is missing or the request times out', async () => {
  let calls = 0;

  await assert.rejects(() => askGroq('hello', {
    env: {},
    fetch: async () => {
      calls += 1;
      return { ok: true, async json() { return {}; } };
    }
  }), /GROQ_API_KEY/);
  assert.equal(calls, 0);

  await assert.rejects(() => askGroq('hello', {
    env: { GROQ_API_KEY: 'test-key' },
    fetch: async () => {
      calls += 1;
      throw new Error('timeout');
    }
  }), /timeout/);
  assert.equal(calls, 1);
});
