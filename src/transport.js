'use strict';

const https = require('node:https');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Native HTTPS avoids fetch's independent headers timeout cutting a long upload short.
// The caller supplies an abort signal covering connection, upload, and response.
function send(url, options) {
  return new Promise((resolve, reject) => {
    let phaseTimer, upload;
    let responded = false;
    const clear = () => clearTimeout(phaseTimer);
    const arm = (ms, code) => {
      clear();
      phaseTimer = setTimeout(() => {
        const error = new Error('Request phase timed out.');
        error.code = code;
        request.destroy(error);
      }, ms);
    };
    const request = https.request(url, {
      method: options.method || 'GET', headers: options.headers, signal: options.signal, timeout: 0
    }, response => {
      responded = true;
      clear();
      options.onPhase?.('response');
      resolve({
        status: response.statusCode,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: { get: name => response.headers[name.toLowerCase()] ?? null },
        body: { cancel: async () => response.destroy() },
        text: async (maximumBytes = 1024 * 1024) => {
          const chunks = [];
          let length = 0;
          for await (const chunk of response) {
            length += chunk.length;
            if (length > maximumBytes) {
              response.destroy();
              const error = new Error('Service index exceeded the size limit.');
              error.code = 'ERR_INDEX_TOO_LARGE';
              throw error;
            }
            chunks.push(chunk);
          }
          return Buffer.concat(chunks).toString('utf8');
        }
      });
    });
    request.on('error', error => { clear(); upload?.destroy(error); reject(error); });
    request.on('close', clear);
    arm(options.connectTimeout ?? 10000, 'CONNECT_TIMEOUT');
    request.on('socket', socket => {
      const connected = () => {
        if (responded || request.destroyed) return;
        options.onPhase?.('upload');
        arm(options.uploadIdleTimeout ?? 60000, 'UPLOAD_IDLE_TIMEOUT');
      };
      if (socket.connecting) socket.once('secureConnect', connected);
      else connected();
    });
    request.on('finish', () => {
      if (responded || request.destroyed) return;
      options.onPhase?.('response');
      arm(options.responseTimeout ?? 120000, 'RESPONSE_TIMEOUT');
    });
    if (options.body) {
      let bytes = 0;
      upload = new Writable({
        write(chunk, encoding, callback) {
          request.write(chunk, encoding, error => {
            if (!error && !responded) {
              bytes += chunk.length;
              options.onProgress?.(bytes);
              arm(options.uploadIdleTimeout ?? 60000, 'UPLOAD_IDLE_TIMEOUT');
            }
            callback(error);
          });
        },
        final(callback) { request.end(callback); },
        destroy(error, callback) { if (error) request.destroy(error); callback(error); }
      });
      pipeline(Readable.from(options.body), upload).catch(reject);
    }
    else request.end();
  });
}

module.exports = { send };
