'use strict';

const https = require('node:https');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Native HTTPS avoids fetch's independent headers timeout cutting a long upload short.
// The caller supplies an abort signal covering connection, upload, and response.
function send(url, options) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: options.method || 'GET', headers: options.headers, signal: options.signal
    }, response => {
      resolve({
        status: response.statusCode,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: { get: name => response.headers[name.toLowerCase()] ?? null },
        body: { cancel: async () => response.destroy() },
        text: async () => {
          const chunks = [];
          let length = 0;
          for await (const chunk of response) {
            length += chunk.length;
            if (length > 1024 * 1024) {
              response.destroy();
              throw new Error('Service index exceeded the size limit.');
            }
            chunks.push(chunk);
          }
          return Buffer.concat(chunks).toString('utf8');
        }
      });
    });
    request.on('error', reject);
    if (options.body) pipeline(Readable.from(options.body), request).catch(reject);
    else request.end();
  });
}

module.exports = { send };
