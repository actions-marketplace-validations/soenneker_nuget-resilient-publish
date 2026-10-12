'use strict';
const { setTimeout: sleep } = require('node:timers/promises');
const { send } = require('./transport');

function retryDelay(header, attempt, random = Math.random, now = Date.now()) {
  const value = header?.trim();
  let milliseconds = value && /^\d+$/.test(value) ? Number(value) * 1000 : NaN;
  if (value && /^[A-Za-z]{3}, /.test(value)) milliseconds = Date.parse(value) - now;
  if (milliseconds > 300000) throw new Error('Retry-After exceeds five minutes; retry the workflow later.');
  if (Number.isFinite(milliseconds)) return Math.max(0, milliseconds);
  return Math.min(60000, 5000 * 2 ** attempt) + Math.floor(random() * 1000);
}

async function request(url, makeOptions, context, { json = false, item } = {}) {
  const { config, signal, info } = context;
  const fetchImpl = context.fetch || send;
  const wait = context.sleep || ((ms, abort) => sleep(ms, undefined, { signal: abort }));
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    if (signal.aborted) throw new Error('Publishing canceled or total time limit reached.');
    // Reopen the file and rebuild multipart content for every attempt.
    const options = await makeOptions();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), json ? Math.min(config.timeout, 30000) : config.timeout);
    let response;
    let body;
    let networkError = false;
    if (item) item.attempts++;
    try {
      response = await fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.any([signal, controller.signal]) });
      if (json && response.ok) body = await response.text();
      else {
        // A definitive response stays authoritative even if cleanup fails.
        try { await response.body?.cancel(); } catch { /* No response content is logged. */ }
      }
    } catch { networkError = true; }
    finally { clearTimeout(timer); }
    if (signal.aborted) throw new Error('Publishing canceled or total time limit reached.');
    if (!networkError && response.ok) {
      if (!json) return 'pushed';
      try { return JSON.parse(body); }
      catch { throw new Error('The NuGet service index returned invalid JSON.'); }
    }
    if (!networkError && response.status === 409 && item && config.skipDuplicate)
      return item.kind === 'symbols' ? 'processing' : 'duplicate';
    const status = networkError ? 'network error or timeout' : `HTTP ${response.status}`;
    // A newly accepted parent can take time to become visible to the symbol service.
    const retryable = networkError || [408, 429, 500, 502, 503, 504].includes(response.status)
      || (response.status === 404 && item?.kind === 'symbols' && item.parentAccepted);
    if (!retryable || attempt === config.retries) {
      const hint = !networkError && [401, 403].includes(response.status)
        ? ' Check API key permissions or obtain a fresh key with nuget-resilient-login.'
        : !networkError && response.status === 413 ? ' The artifact exceeds the server size limit.'
        : !networkError && response.status === 400 ? ' Check the package contents and feed requirements.'
        : !networkError && response.status >= 300 && response.status < 400 ? ' Redirects are refused to protect the API key.' : '';
      const error = new Error(`Upload/request failed (${status}) after ${attempt + 1} attempt(s).${hint}`);
      error.stop = !networkError && [401, 403, 429].includes(response.status);
      throw error;
    }
    let delay;
    try { delay = retryDelay(networkError ? null : response.headers.get('retry-after'), attempt, context.random, context.now?.()); }
    catch (error) { error.stop = true; throw error; }
    info(`Retry ${attempt + 1}/${config.retries} in ${Math.ceil(delay / 1000)}s (${status}).`);
    try { await wait(delay, signal); }
    catch { throw new Error('Publishing canceled or total time limit reached.'); }
  }
}
module.exports = { request, retryDelay };
