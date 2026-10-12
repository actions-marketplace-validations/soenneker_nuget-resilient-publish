'use strict';
const { glob, stat, realpath, access } = require('node:fs/promises');
const { constants } = require('node:fs');
const { resolve, relative, basename } = require('node:path');

async function discover(patterns, cwd, includeSymbols, { requireSymbols = false, requiredPackages = [] } = {}) {
  const paths = new Map();
  async function add(path) {
    const actual = await realpath(path);
    const info = await stat(actual);
    if (!info.isFile() || info.size === 0) throw new Error('Every selected artifact must be a nonempty regular file.');
    await access(actual, constants.R_OK);
    const kind = /\.snupkg$/i.test(path) ? 'symbols' : 'package';
    if (!/\.(snupkg|nupkg)$/i.test(path) || /\.symbols\.nupkg$/i.test(path))
      throw new Error('Select .nupkg or .snupkg files; legacy .symbols.nupkg files are unsupported.');
    if (kind === 'symbols' && !includeSymbols) return;
    if (!paths.has(actual)) paths.set(actual, { path: actual, file: relative(cwd, path).replaceAll('\\', '/'), name: basename(path), sizeBytes: info.size, kind, status: 'pending', attempts: 0, durationMs: 0, attemptDetails: [] });
  }
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) throw new Error('Negated package patterns are unsupported. Use explicit paths or positive glob patterns.');
    let matched = false;
    for await (const path of glob(pattern.replaceAll('\\', '/'), { cwd })) {
      matched = true;
      await add(resolve(cwd, path));
    }
    if (!matched) throw new Error('A packages pattern matched no files. Check the artifact paths before publishing.');
  }
  if (includeSymbols) {
    for (const item of [...paths.values()]) {
      if (item.kind !== 'package') continue;
      const companion = item.path.replace(/\.nupkg$/i, '.snupkg');
      try { await stat(companion); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (requireSymbols) throw new Error(`Required symbol companion is missing for ${item.file}.`);
        continue;
      }
      await add(companion);
      paths.get(await realpath(companion)).parent = item.path;
    }
  }
  if (!paths.size) throw new Error('No publishable artifacts were selected.');
  // Exact filenames include the version and avoid ambiguous ID/version splitting.
  const names = new Map();
  for (const item of paths.values()) {
    if (item.kind !== 'package') continue;
    const key = item.name.toLowerCase();
    if (names.has(key)) throw new Error(`Multiple selected files have the same package filename: ${item.name}.`);
    names.set(key, item);
  }
  for (const name of requiredPackages) {
    if (!/^[^\\/*?\[\]{}\r\n]+\.nupkg$/i.test(name) || /\.symbols\.nupkg$/i.test(name))
      throw new Error('required-packages must contain exact .nupkg filenames, including versions, without paths or globs.');
    if (!names.has(name.toLowerCase())) throw new Error(`Required package is missing from the selected files: ${name}.`);
  }
  return [...paths.values()].sort((a, b) => (a.kind === b.kind ? a.file.localeCompare(b.file) : a.kind === 'package' ? -1 : 1));
}
module.exports = { discover };
