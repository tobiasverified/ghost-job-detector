import { createHmac, randomBytes } from 'node:crypto';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const secret = String(process.env.INVITE_KEY_SECRET || '');
const label = argument('--label').slice(0, 80);
const limit = Number(argument('--limit'));

if (!secret) {
  fail('INVITE_KEY_SECRET is not set');
}

if (!label) {
  fail('--label is required');
}

if (!Number.isInteger(limit) || limit < 1 || limit > 1000000) {
  fail('--limit must be a whole number from 1 to 1000000');
}

const id = randomBytes(9).toString('base64url');
const payload = Buffer.from(JSON.stringify({ id, label, limit }), 'utf8').toString('base64url');
const signature = createHmac('sha256', secret).update(payload).digest('base64url');

process.stdout.write(`ghd_${payload}.${signature}\n`);
