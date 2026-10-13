'use strict';

function sanitize(value, secrets) {
  let text = value;
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text
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
  if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
    await response.body?.cancel();
    return undefined;
  }
  const reader = response.body?.getReader?.();
  if (!reader && !response.text) return undefined;
  const chunks = [];
  let length = 0;
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) return undefined;
      chunks.push(Buffer.from(value));
    }
    const data = JSON.parse(reader ? Buffer.concat(chunks).toString('utf8') : await response.text(8192));
    // Redact credential fields even when their values are echoed in the message.
    const sensitive = [...secrets];
    function collect(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (/api.?key|token|authorization|password|secret|^value$/i.test(key) && typeof child === 'string') sensitive.push(child);
        else collect(child);
      }
    }
    collect(data);
    const message = typeof data?.error === 'string' ? data.error : data?.error?.message ?? data?.message;
    return typeof message === 'string' ? sanitize(message, sensitive) : undefined;
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

async function readErrorMessage(response, secrets, signal) {
  let abort;
  try {
    return await Promise.race([
      new Promise((resolve, reject) => {
        abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }),
      errorMessage(response, secrets)
    ]);
  } catch {
    // Missing, oversized, malformed, and stalled diagnostics never change HTTP handling.
    return undefined;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

module.exports = { responseHeaders, readErrorMessage };
