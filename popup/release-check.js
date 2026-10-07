import { GITHUB_URL, PRIVACY_URL, SUPPORT_EMAIL } from './config.js';

const missing = Object.entries({
  SUPPORT_EMAIL,
  GITHUB_URL,
  PRIVACY_URL
}).filter(([, value]) => !String(value || '').trim()).map(([name]) => name);

if (missing.length) {
  console.error(`Release check failed. Set these in popup/config.js: ${missing.join(', ')}`);
  process.exit(1);
}
