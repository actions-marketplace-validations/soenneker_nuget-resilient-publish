'use strict';
const { input } = require('./runtime');
const { validateHeaderValue } = require('node:http');

function integer(value, fallback, min, max, name) {
  const number = Number(value || fallback);
  if (!/^\d+$/.test(value || String(fallback)) || !Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return number;
}

function boolean(value, fallback, name) {
  if (!value) return fallback;
  if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false.`);
  return value === 'true';
}

function httpsUrl(value, name) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error();
    return url.href;
  } catch { throw new Error(`${name} must be an HTTPS URL without credentials, query parameters, or a fragment.`); }
}

function settings(env) {
  const get = name => input(name, env);
  const apiKey = get('api-key') || env.NUGET_API_KEY?.trim();
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('Provide api-key or NUGET_API_KEY with a valid single-line API key.');
  try { validateHeaderValue('X-NuGet-ApiKey', apiKey); }
  catch { throw new Error('The API key contains invalid HTTP header characters.'); }
  return {
    apiKey,
    patterns: (get('packages') || 'artifacts/*.nupkg').split(/\r?\n/).map(p => p.trim()).filter(Boolean),
    source: httpsUrl(get('source') || 'https://api.nuget.org/v3/index.json', 'source'),
    symbols: boolean(get('include-symbols'), true, 'include-symbols'),
    skipDuplicate: boolean(get('skip-duplicate'), true, 'skip-duplicate'),
    retries: integer(get('max-retries'), 3, 0, 10, 'max-retries'),
    timeout: integer(get('timeout-seconds'), 600, 1, 1800, 'timeout-seconds') * 1000,
    totalTimeout: integer(get('total-timeout-seconds'), 3300, 1, 21600, 'total-timeout-seconds') * 1000
  };
}
module.exports = { settings, httpsUrl };
