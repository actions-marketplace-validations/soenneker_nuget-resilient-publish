'use strict';

const { appendFile } = require('node:fs/promises');
const { multipart } = require('./multipart');
const { settings, httpsUrl } = require('./settings');
const { discover } = require('./files');
const { request } = require('./http');
const { mask } = require('./runtime');
const { coordination, pool } = require('./batch');
const { report } = require('./report');

async function run(env = process.env, dependencies = {}) {
  if (!dependencies.output && !env.GITHUB_OUTPUT)
    throw new Error('GITHUB_OUTPUT is unavailable. Run this action in a GitHub Actions step.');
  const config = settings(env);
  (dependencies.mask || mask)(config.apiKey);
  if (!dependencies.output) {
    try { await appendFile(env.GITHUB_OUTPUT, ''); }
    catch { throw new Error('GITHUB_OUTPUT is not writable; publishing has not started.'); }
  }
  const redact = value => String(value).replaceAll(config.apiKey, '***');
  const info = value => (dependencies.info || (message => process.stdout.write(`${message}\n`)))(redact(value).replace(/[\x00-\x1f\x7f]/g, ' ').replaceAll('::', ': :'));
  const now = dependencies.now || Date.now;
  const started = now();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const timer = setTimeout(cancel, config.totalTimeout);
  const signal = dependencies.signal ? AbortSignal.any([controller.signal, dependencies.signal]) : controller.signal;
  const control = coordination({ ...dependencies, signal, now, info });
  const context = { ...dependencies, config, signal, info, control };
  let items = [];
  let failure;
  let progressTimer;
  const progress = () => {
    const completed = items.filter(item => !['pending', 'uploading'].includes(item.status)).length;
    const elapsed = Math.max(0, now() - started);
    info(`Batch: ${completed}/${items.length} finished; ${items.filter(item => item.status === 'uploading').length} active; ${Math.floor(elapsed / 1000)}s elapsed; ${Math.max(0, Math.ceil((config.totalTimeout - elapsed) / 1000))}s remaining in time budget.`);
  };
  try {
    items = await discover(config.patterns, env.GITHUB_WORKSPACE || process.cwd(), config.symbols, config);
    info(`Found ${items.filter(i => i.kind === 'package').length} package(s) and ${items.filter(i => i.kind === 'symbols').length} symbol artifact(s); concurrency ${config.concurrency}.`);
    progressTimer = setInterval(progress, 15000);
    const index = await request(config.source, async () => ({ headers: { Accept: 'application/json', 'User-Agent': 'nuget-resilient-publish' } }), context, { json: true });
    const endpoints = {};
    for (const [kind, type] of [['package', 'PackagePublish/2.0.0'], ['symbols', 'SymbolPackagePublish/4.9.0']]) {
      if (!items.some(item => item.kind === kind)) continue;
      const resource = Array.isArray(index?.resources) && index.resources.find(r => [].concat(r?.['@type'] || []).includes(type));
      if (!resource) throw new Error(`The service index does not provide ${type}. Disable include-symbols for feeds without symbol support.`);
      endpoints[kind] = httpsUrl(resource['@id'], `${kind} endpoint`);
    }
    const byPath = new Map(items.map(item => [item.path, item]));
    const publish = async item => {
      if (item.parent) {
        const parent = byPath.get(item.parent);
        if (!['pushed', 'duplicate'].includes(parent.status)) {
          item.status = 'skipped';
          item.error = 'Parent package upload did not succeed.';
          progress();
          return;
        }
        item.parentAccepted = true;
      }
      const itemStarted = now();
      item.status = 'uploading';
      info(`Publishing ${item.kind}: ${item.file} (${item.sizeBytes} bytes)`);
      try {
        item.status = await request(endpoints[item.kind], async () => {
          const content = await multipart(item.path);
          return { method: 'PUT', headers: { ...content.headers, 'X-NuGet-ApiKey': config.apiKey, 'X-NuGet-Protocol-Version': '4.1.0', 'User-Agent': 'nuget-resilient-publish/1.0.0' }, body: content.body };
        }, context, { item });
        info(`${item.file}: ${item.status} (${item.attempts} attempt(s)).`);
      } catch (error) {
        item.status = error.endpointUnavailable ? 'skipped' : 'failed';
        item.error = error.endpointUnavailable ? 'Endpoint recovery failed; this artifact was not uploaded.' : /^(Upload\/request failed|Retry-After|Publishing canceled)/.test(error.message)
          ? error.message : 'Unable to read or upload the artifact.';
        info(`${item.file}: ${item.error}`);
        if (error.stop || signal.aborted || control.stopped) throw new Error(item.error);
      } finally {
        item.durationMs = Math.max(0, now() - itemStarted);
        progress();
      }
    };
    // Preserve the package-first barrier, even with multiple upload workers.
    await pool(items.filter(item => item.kind === 'package'), config.concurrency, control, signal, publish);
    if (signal.aborted) throw new Error('Publishing canceled or total time limit reached.');
    await pool(items.filter(item => item.kind === 'symbols'), config.concurrency, control, signal, publish);
    if (signal.aborted) throw new Error('Publishing canceled or total time limit reached.');
    if (items.some(item => item.status === 'failed')) throw new Error('One or more artifacts failed. Inspect the per-artifact results; successful uploads were retained.');
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    clearInterval(progressTimer);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    for (const item of items) if (item.status === 'pending') { item.status = 'skipped'; item.error = 'Publishing stopped before this artifact was attempted.'; }
    const reportingFailure = await report(items, Math.max(0, now() - started), failure, env, dependencies, redact, info);
    failure ||= reportingFailure;
  }
  if (failure) throw new Error(redact(failure.message));
}

module.exports = { run };
