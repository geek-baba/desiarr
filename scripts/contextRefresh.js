#!/usr/bin/env node

/**
 * Context refresh utility:
 * - Rebuilds docs/repo-map.md tree + SLOC sections
 * - Updates CODE-NAV timestamp
 * - Validates local Markdown links under docs/ and README.md
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPO_MAP = path.join(ROOT, 'docs', 'repo-map.md');
const CODE_NAV = path.join(ROOT, 'docs', 'CODE-NAV.md');
const DOCS_DIR = path.join(ROOT, 'docs');
const README = path.join(ROOT, 'README.md');

const TREE_MAX_DEPTH = 3;
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.cursor', '.idea', 'dist']);
const COUNT_EXTS = new Set(['.ts', '.js', '.ejs', '.tsx', '.jsx']);

function nowUtc() {
  return new Date().toISOString().replace('T', ' ').replace(/\..+/, '') + ' UTC';
}

function buildTree(dir, depth = 0, prefix = '') {
  if (depth > TREE_MAX_DEPTH) return '';
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') || entry.name === '.git')
    .filter((entry) => !IGNORE_DIRS.has(entry.name))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  let output = '';
  entries.forEach((entry, index) => {
    const isLast = index === entries.length - 1;
    const branch = prefix + (isLast ? '└── ' : '├── ');
    const rel = depth === 0 ? entry.name : entry.name;
    output += `${branch}${rel}\n`;
    if (entry.isDirectory() && depth + 1 < TREE_MAX_DEPTH) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      output += buildTree(path.join(dir, entry.name), depth + 1, childPrefix);
    }
  });
  return output;
}

function walkFiles(dir, predicate = () => true) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const resolved = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(resolved, predicate));
    } else if (predicate(resolved)) {
      files.push(resolved);
    }
  }
  return files;
}

function countSloc() {
  const files = walkFiles(ROOT, (file) => COUNT_EXTS.has(path.extname(file)));
  const moduleTotals = {};
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const key = deriveModuleKey(rel);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).length;
    moduleTotals[key] = (moduleTotals[key] || 0) + lines;
  }
  return Object.entries(moduleTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([key, loc]) => ({ key, loc }));
}

function deriveModuleKey(relPath) {
  if (relPath.startsWith('src/')) {
    const parts = relPath.split('/');
    if (parts.length >= 3) return `${parts[0]}/${parts[1]}`;
    return relPath;
  }
  if (relPath.startsWith('views/')) return 'views';
  if (relPath.startsWith('public/')) return 'public';
  return relPath.split('/')[0];
}

function replaceSection(content, startHeading, endHeading, replacement) {
  const startIdx = content.indexOf(startHeading);
  if (startIdx === -1) throw new Error(`Could not find start heading "${startHeading}"`);
  const fromStart = content.slice(startIdx);
  const endIdx = fromStart.indexOf(endHeading);
  if (endIdx === -1) throw new Error(`Could not find end heading "${endHeading}"`);
  const before = content.slice(0, startIdx);
  const after = fromStart.slice(endIdx);
  return before + replacement + after;
}

function updateRepoMap() {
  if (!fs.existsSync(REPO_MAP)) throw new Error('docs/repo-map.md is missing');
  let content = fs.readFileSync(REPO_MAP, 'utf8');
  const stamp = nowUtc();
  content = content.replace(/_Last refreshed: .*?_/g, `_Last refreshed: ${stamp}_`);

  const treeContent = ('.\n' + buildTree(ROOT)).trimEnd();
  const treeBlock = [
    '## Folder Tree (depth 3)',
    '```',
    treeContent,
    '```',
    `- Source: auto-generated via npm run context:refresh (${stamp})`,
    '',
  ].join('\n');

  const slocRows = countSloc()
    .slice(0, 8)
    .map(({ key, loc }) => `| \`${key}\` | ${loc.toLocaleString()} |`);
  const slocBlock = [
    '## SLOC by Top Modules',
    '| Module / directory | Total LOC |',
    '| --- | --- |',
    ...slocRows,
    `- Source: auto-generated via npm run context:refresh (${stamp})`,
    '',
  ].join('\n');

  content = replaceSection(
    content,
    '## Folder Tree (depth 3)',
    '## SLOC by Top Modules',
    `${treeBlock}\n`
  );
  content = replaceSection(
    content,
    '## SLOC by Top Modules',
    '## Environment Variables',
    `${slocBlock}\n`
  );
  fs.writeFileSync(REPO_MAP, content);
}

function updateCodeNav() {
  if (!fs.existsSync(CODE_NAV)) return;
  let content = fs.readFileSync(CODE_NAV, 'utf8');
  const stamp = nowUtc();
  content = content.replace(/_Last refreshed: .*?_/g, `_Last refreshed: ${stamp}_`);
  fs.writeFileSync(CODE_NAV, content);
}

function validateLinks() {
  const files = [README, ...walkFiles(DOCS_DIR, (file) => file.endsWith('.md'))];
  const broken = [];
  const linkRegex = /\[[^\]]+\]\(([^)]+)\)/g;
  files.forEach((file) => {
    const text = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = linkRegex.exec(text)) !== null) {
      const target = match[1];
      if (
        target.startsWith('http://') ||
        target.startsWith('https://') ||
        target.startsWith('mailto:') ||
        target.startsWith('#')
      ) {
        continue;
      }
      const resolved = path.resolve(path.dirname(file), target);
      if (!fs.existsSync(resolved)) {
        broken.push(`${path.relative(ROOT, file)} -> ${target}`);
      }
    }
  });
  if (broken.length > 0) {
    throw new Error(`Broken markdown links detected:\n${broken.join('\n')}`);
  }
}

function main() {
  updateRepoMap();
  updateCodeNav();
  validateLinks();
  console.log('Context refresh complete.');
}

main();


