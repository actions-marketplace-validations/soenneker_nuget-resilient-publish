'use strict';

const { createReadStream } = require('node:fs');
const { stat } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

async function multipart(path) {
  const size = (await stat(path)).size;
  const boundary = `nuget_${randomUUID()}`;
  // A fixed filename prevents local filenames from injecting multipart headers.
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="package"; filename="upload.nupkg"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(prefix.length + size + suffix.length) },
    body: (async function* () {
      yield prefix;
      const stream = createReadStream(path);
      try { yield* stream; }
      finally { stream.destroy(); }
      yield suffix;
    })()
  };
}

module.exports = { multipart };
