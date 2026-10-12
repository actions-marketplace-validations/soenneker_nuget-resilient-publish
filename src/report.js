'use strict';

const { appendFile } = require('node:fs/promises');
const { output } = require('./runtime');

async function report(items, durationMs, failure, env, dependencies, redact, info) {
  const results = items.map(({ file, kind, status, attempts, sizeBytes, durationMs, httpStatus, reason, attemptDetails, error }) => ({
    file: redact(file), kind, status, attempts, sizeBytes, durationMs,
    ...(httpStatus !== undefined ? { httpStatus } : {}), ...(reason ? { reason } : {}), attemptDetails,
    ...(error ? { error: redact(error) } : {})
  }));
  const emit = dependencies.output || ((name, value) => output(name, value, env));
  const values = { results: JSON.stringify(results), 'duration-seconds': (durationMs / 1000).toFixed(3), total: String(results.length) };
  for (const status of ['pushed', 'duplicate', 'processing', 'failed', 'skipped'])
    values[status] = String(results.filter(item => item.status === status).length);
  let outputFailure;
  for (const [name, value] of Object.entries(values)) {
    try { await emit(name, value); }
    catch {
      outputFailure ||= new Error('Publishing finished, but one or more action outputs could not be written.');
      info(`Unable to write the ${name} output.`);
    }
  }
  if (env.GITHUB_STEP_SUMMARY) {
    const html = value => redact(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replace(/[|`\[\]*_~\\]/g, char => `&#${char.charCodeAt(0)};`).replace(/[\x00-\x1f\x7f]/g, ' ');
    const rows = results.map(item => `| ${html(item.file)} | ${item.kind} | ${item.status} | ${item.attempts} | ${item.sizeBytes} | ${(item.durationMs / 1000).toFixed(2)} | ${html(item.reason || '')} | ${html(item.error || '')} |`);
    try {
      await (dependencies.appendSummary || appendFile)(env.GITHUB_STEP_SUMMARY,
        `\n### NuGet publishing${failure ? ' — failed' : ''}\n\n${results.length} artifacts; ${(durationMs / 1000).toFixed(2)} seconds elapsed.\n\n| Artifact | Type | Result | Attempts | Bytes | Seconds | Last response | Detail |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\nAccepted uploads may still be undergoing server validation. Symbol processing is not confirmation of availability.\n`);
    } catch { info('Unable to write the job summary; publishing results are unchanged.'); }
  }
  return outputFailure;
}

module.exports = { report };
