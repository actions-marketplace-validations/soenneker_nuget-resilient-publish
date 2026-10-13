'use strict';

function sanitize(value, secrets) {
  let text = value;
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text
    .replace(/\b(?:api[-_ ]?key|access[-_ ]?token|id[-_ ]?token|token|authorization|password|secret)\b["']?\s*[:=]\s*(["'])(.*?)\1/gis, '[redacted credential]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:api[-_ ]?key|access[-_ ]?token|id[-_ ]?token|token|authorization|password|secret)\b["']?\s*[:=]\s*["']?[^\s,"'}]+/gi, '[redacted credential]')
    .replace(/\b[A-Za-z0-9_+/=-]{32,}(?:\.[A-Za-z0-9_+/=-]+)*/g, '[redacted]')
    .replace(/https?:\/\/\S+/gi, '[redacted URL]')
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')
    .replace(/::/g, ': :')
    .slice(0, 512);
}

function responseHeaders(response, secrets) {
  const details = {};
  for (const name of ['content-type', 'retry-after', 'x-request-id', 'x-correlation-id', 'request-id', 'x-ms-request-id', 'x-github-request-id']) {
    const value = response.headers?.get(name);
    if (typeof value === 'string') details[name] = sanitize(value, secrets);
  }
  return details;
}

async function errorMessage(response, secrets) {
  const contentType = response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase();
  const json = contentType === 'application/json' || contentType?.endsWith('+json');
  if (contentType && !json && contentType !== 'text/plain') {
    response.body?.cancel?.().catch(() => {});
    return { bodyStatus: 'unsupported_content_type' };
  }
  const reader = response.body?.getReader?.();
  if (!reader && !response.text) return { bodyStatus: 'unavailable' };
  try {
    const chunks = [];
    let length = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) return { bodyStatus: 'too_large' };
      chunks.push(Buffer.from(value));
    }
    const text = reader ? Buffer.concat(chunks).toString('utf8') : await response.text(8192);
    if (Buffer.byteLength(text) > 8192) return { bodyStatus: 'too_large' };
    if (!text.trim()) return { bodyStatus: 'empty' };
    // Without a content type, do not treat HTML or binary data as plain text.
    if (!json && !contentType && /^\s*</.test(text)) return { bodyStatus: 'unsupported_content_type' };
    if (!json && /[\x00-\x08\x0e-\x1f]/.test(text)) return { bodyStatus: 'unsupported_content_type' };
    if (!json) return { bodyStatus: 'text', message: sanitize(text, secrets) };
    let data;
    try { data = JSON.parse(text); }
    catch { return { bodyStatus: 'invalid_json' }; }
    const sensitive = [...secrets];
    function collect(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (/api.?key|token|authorization|password|secret|^value$/i.test(key) && typeof child === 'string') sensitive.push(child);
        else collect(child);
      }
    }
    collect(data);
    const message = typeof data?.error === 'string' ? data.error : data?.error?.message ?? data?.message ?? data?.detail ?? data?.title;
    return typeof message === 'string'
      ? { bodyStatus: 'json', message: sanitize(message, sensitive) }
      : { bodyStatus: 'no_error_message' };
  } catch (error) {
    return { bodyStatus: error?.code === 'ERR_INDEX_TOO_LARGE' ? 'too_large' : 'read_error' };
  } finally {
    // Cleanup must not hold the HTTP outcome hostage to a stalled stream.
    if (reader) reader.cancel().catch(() => {}).finally(() => reader.releaseLock()).catch(() => {});
    else response.body?.cancel?.().catch(() => {});
  }
}

async function readErrorMessage(response, secrets, signal) {
  let abort;
  try {
    return await Promise.race([
      new Promise(resolve => {
        abort = () => resolve({ bodyStatus: 'timeout' });
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }),
      errorMessage(response, secrets)
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

module.exports = { responseHeaders, errorMessage, readErrorMessage };
