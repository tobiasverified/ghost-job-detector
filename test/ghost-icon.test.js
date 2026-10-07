import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const linkedin = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const workday = readFileSync(new URL('../content/workday.js', import.meta.url), 'utf8');
const widget = readFileSync(new URL('../lib/widget.js', import.meta.url), 'utf8');
const manifest = readFileSync(new URL('../manifest.json', import.meta.url), 'utf8');

function ghostBody(source) {
  const match = source.match(/const GHOST_BODY = '([^']+)'/);
  assert.ok(match, 'ghost path');
  return match[1];
}

test('job card badges draw the same inline ghost on the purple circle', () => {
  const body = ghostBody(linkedin);

  assert.equal(ghostBody(workday), body);
  assert.equal(body.includes('M'), true);
  assert.equal(linkedin.includes('👻'), false);
  assert.equal(workday.includes('👻'), false);
  assert.equal(linkedin.includes('data:image'), false);
  assert.equal(workday.includes('data:image'), false);
  assert.equal(linkedin.includes("setAttribute('fill', '#ffffff')"), true);
  assert.equal(workday.includes("setAttribute('fill', '#ffffff')"), true);
  assert.equal(linkedin.includes("eye(9), eye(15)"), true);
  assert.equal(workday.includes("eye(9), eye(15)"), true);
  assert.equal(/setAttribute\('stroke'/.test(linkedin), false);
  assert.equal(/setAttribute\('stroke'/.test(workday), false);
  assert.equal(linkedin.includes("'width:32px'"), true);
  assert.equal(linkedin.includes("'height:32px'"), true);
  assert.equal(linkedin.includes("'background:#6d4aff'"), true);
  assert.equal(linkedin.includes('appendGhostIcon(badge, 16)'), true);
  assert.equal(workday.includes("'width:28px'"), true);
  assert.equal(workday.includes("'height:28px'"), true);
  assert.equal(workday.includes("'background:#6d4aff'"), true);
  assert.equal(workday.includes('appendGhostIcon(badge, 16)'), true);
  assert.equal(linkedin.includes('saveJob(withSearchOpenJobs(job))'), true);
  assert.equal(workday.includes("source: 'WORKDAY_LIST'"), true);
  assert.equal(manifest.includes('web_accessible_resources'), false);
});

test('the widget title uses the same ghost without a circle', () => {
  assert.equal(ghostBody(widget), ghostBody(linkedin));
  assert.equal(widget.includes('👻'), false);
  assert.equal(widget.includes('data:image'), false);
  assert.equal(widget.includes('fill="#ffffff"'), true);
  assert.equal(widget.includes('cx="9"'), true);
  assert.equal(widget.includes('cx="15"'), true);
  const ghostMarkup = widget.slice(widget.indexOf('function ghostSvg'), widget.indexOf('function titleBar'));
  assert.equal(ghostMarkup.includes('stroke'), false);
  assert.equal(widget.includes('ghostSvg(16)'), true);
  assert.equal(widget.split('${titleBar()}').length - 1, 4);
});
