import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const srcDir = path.join(projectRoot, 'node_modules/pyodide');
const destDir = path.join(projectRoot, 'public/pyodide');

if (!fs.existsSync(srcDir)) {
  console.log('node_modules/pyodide not found, skipping pyodide preparation.');
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });

const filesToCopy = [
  'pyodide.js',
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
];

for (const file of filesToCopy) {
  const src = path.join(srcDir, file);
  const dest = path.join(destDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}

// Copy wheels (*.whl)
const allFiles = fs.readdirSync(srcDir);
for (const f of allFiles) {
  if (f.endsWith('.whl')) {
    fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
  }
}

console.log('✅ Pyodide runtime & scientific wheels synchronized to public/pyodide/');
