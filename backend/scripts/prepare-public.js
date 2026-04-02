'use strict';

const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');
const ROOT_DIR = path.join(BACKEND_DIR, '..');
const PUBLIC_DIR = path.join(BACKEND_DIR, 'public');

const FILES_TO_COPY = [
  [path.join(ROOT_DIR, 'quido_home.html'), path.join(PUBLIC_DIR, 'home.html')],
  [path.join(ROOT_DIR, 'quido_loans.html'), path.join(PUBLIC_DIR, 'customer.html')],
  [path.join(ROOT_DIR, 'quido_ops.html'), path.join(PUBLIC_DIR, 'ops.html')]
];

const DIRS_TO_COPY = [
  [path.join(ROOT_DIR, 'shared'), path.join(PUBLIC_DIR, 'shared')]
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(sourcePath, targetPath) {
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function copyDir(sourceDir, targetDir) {
  ensureDir(targetDir);
  fs.readdirSync(sourceDir, { withFileTypes: true }).forEach(function (entry) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
      return;
    }
    copyFile(sourcePath, targetPath);
  });
}

function main() {
  ensureDir(PUBLIC_DIR);
  FILES_TO_COPY.forEach(function (pair) { copyFile(pair[0], pair[1]); });
  DIRS_TO_COPY.forEach(function (pair) { copyDir(pair[0], pair[1]); });
  console.log('Prepared backend/public assets for deployment.');
}

main();
