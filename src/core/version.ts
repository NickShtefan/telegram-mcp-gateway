import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
if (typeof version !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version)) {
  throw new Error('Invalid application release version.');
}
export const RELEASE_VERSION = version;
