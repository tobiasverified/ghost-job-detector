import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function markdownHeadings(text) {
  return text.split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+\S/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim());
}

function htmlHeadings(text) {
  return [...text.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((match) => match[2].replace(/<[^>]+>/g, '').trim());
}

test('the privacy page headings match PRIVACY.md', () => {
  const markdown = readFileSync(new URL('../PRIVACY.md', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8');
  const headings = markdownHeadings(markdown);

  assert.ok(headings.length > 1);
  assert.deepEqual(htmlHeadings(html), headings);
  assert.equal(/<script\b/i.test(html), false);
  assert.equal(/\s(?:src|href)\s*=\s*["']https?:/i.test(html), false);
});
