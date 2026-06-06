#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const buildPath = path.join(root, 'local-build.json');

let data = {};
try {
  data = JSON.parse(fs.readFileSync(buildPath, 'utf8'));
} catch {
  data = {};
}

const baseVersion = String(pkg.version || '0.0.0');
const previousBase = String(data.baseVersion || '');
let build = Number(data.build || 0);
if (!Number.isInteger(build) || build < 0 || previousBase !== baseVersion) {
  build = 0;
}
build += 1;

const next = { baseVersion, build };
fs.writeFileSync(buildPath, JSON.stringify(next, null, 2) + '\n');
console.log(`[local-build] v${baseVersion}.${build}`);
