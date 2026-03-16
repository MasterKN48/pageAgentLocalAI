import { cpSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = resolve(root, 'dist');
const pub = resolve(root, 'public');

// Copy all public assets to dist
// Vite doesn't auto-copy public/ when using rollupOptions.input (library mode)
function copyDir(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}

// Copy manifest.json
cpSync(resolve(pub, 'manifest.json'), resolve(dist, 'manifest.json'));
console.log('Copied manifest.json');

// Copy icons
copyDir(resolve(pub, 'icons'), resolve(dist, 'icons'));
console.log('Copied icons/');

// Copy offscreen HTML
copyDir(resolve(pub, 'offscreen'), resolve(dist, 'offscreen'));
console.log('Copied offscreen/');

// Copy sidepanel HTML and CSS
copyDir(resolve(pub, 'sidepanel'), resolve(dist, 'sidepanel'));
console.log('Copied sidepanel/');

console.log('Post-build complete!');
