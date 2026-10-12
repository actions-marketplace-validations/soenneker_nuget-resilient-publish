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

function classify(error, timedOut, phase) {
  if (timedOut) return { reason: `${phase}-timeout`, retryable: true };
  const code = error?.code;
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE'].includes(code))
    return { reason: code, retryable: true };
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code || '')) return { reason: 'tls-error', retryable: false };
  if (['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'EIO'].includes(code)) return { reason: 'file-error', retryable: false };
  if (code === 'ENOTFOUND') return { reason: 'dns-not-found', retryable: false };
  if (code === 'ERR_INDEX_TOO_LARGE') return { reason: 'index-too-large', retryable: false };
  return { reason: 'transport-error', retryable: false };
}

async function request(url, makeOptions, context, { json = false, item } = {}) {
  const { config, signal, info, control } = context;
  const fetchImpl = context.fetch || send;
  const wait = context.sleep || ((ms, abort) => sleep(ms, undefined, { signal: abort }));
  const now = context.now || Date.now;
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    if (signal.aborted || control?.stopped) throw new Error('Publishing canceled or total time limit reached.');
    try { await control?.ready(); }
    catch { throw new Error('Publishing canceled or total time limit reached.'); }
    if (signal.aborted || control?.stopped) throw new Error('Publishing canceled or total time limit reached.');
    let options;
    try { options = await makeOptions(); }
    catch {
      if (item) item.reason = 'file-error';
      throw new Error('Upload/request failed (file-error). Check artifact accessibility.');
    }
    // File preparation yields; another worker may have throttled or stopped meanwhile.
    try { await control?.ready(); }
    catch { throw new Error('Publishing canceled or total time limit reached.'); }
    if (signal.aborted || control?.stopped) throw new Error('Publishing canceled or total time limit reached.');
    const controller = new AbortController();
    const timeout = json ? Math.min(config.timeout, 30000) : item?.kind === 'symbols' ? (config.symbolTimeout ?? config.timeout) : config.timeout;
    const timer = setTimeout(() => controller.abort(), timeout);
    const started = now();
    let response;
    let body;
    let failure;
    let phase = 'connection';
    if (item) item.attempts++;
    try {
      response = await fetchImpl(url, { ...options, redirect: 'manual', onPhase: value => { phase = value; }, signal: AbortSignal.any([signal, controller.signal]) });
      if (json && response.ok) body = await response.text();
      else {
        try { await response.body?.cancel(); } catch { /* A definitive HTTP response remains authoritative. */ }
      }
    } catch (error) { failure = classify(error, controller.signal.aborted, phase); }
    finally { clearTimeout(timer); }
    if (signal.aborted) failure = { reason: 'canceled', retryable: false };
    const reason = failure?.reason || `HTTP ${response.status}`;
    if (item) {
      item.reason = reason;
      item.httpStatus = failure ? undefined : response.status;
      (item.attemptDetails ||= []).push({ attempt: attempt + 1, durationMs: Math.max(0, now() - started), reason,
        ...(!failure ? { httpStatus: response.status } : {}) });
    }
    if (signal.aborted) throw new Error('Publishing canceled or total time limit reached.');
    if (!failure && response.ok) {
      if (!json) return 'pushed';
      try { return JSON.parse(body); }
      catch { throw new Error('The NuGet service index returned invalid JSON.'); }
    }
    if (!failure && response.status === 409 && item && config.skipDuplicate)
      return item.kind === 'symbols' ? 'processing' : 'duplicate';
    const retryable = failure ? failure.retryable : [408, 429, 500, 502, 503, 504].includes(response.status)
      || (response.status === 404 && item?.kind === 'symbols' && item.parentAccepted);
    if (!retryable || attempt === config.retries) {
      const hint = !failure && [401, 403].includes(response.status)
        ? ' Check API key permissions or obtain a fresh key with nuget-resilient-login.'
        : !failure && response.status === 413 ? ' The artifact exceeds the server size limit.'
        : !failure && response.status === 400 ? ' Check the package contents and feed requirements.'
        : !failure && response.status >= 300 && response.status < 400 ? ' Redirects are refused to protect the API key.' : '';
      const error = new Error(`Upload/request failed (${reason}) after ${attempt + 1} attempt(s).${hint}`);
      error.stop = (!failure && [401, 403, 429].includes(response.status)) || failure?.reason === 'tls-error';
      if (error.stop && control) { control.stopped = true; control.failure ||= error; }
      throw error;
    }
    let delay;
    try { delay = retryDelay(failure ? null : response.headers.get('retry-after'), attempt, context.random, now()); }
    catch (error) { error.stop = true; if (control) { control.stopped = true; control.failure ||= error; } throw error; }
    if (item) item.attemptDetails.at(-1).retryDelayMs = delay;
    info(`${item ? item.file + ': ' : ''}Retry ${attempt + 1}/${config.retries} in ${Math.ceil(delay / 1000)}s (${reason}).`);
    if (!failure && response.status === 429 && control) control.throttle(delay);
    else {
      try { await wait(delay, control?.waitSignal || signal); }
      catch { throw new Error('Publishing canceled or total time limit reached.'); }
    }
  }
}
module.exports = { request, retryDelay, classify };
