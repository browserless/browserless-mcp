import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const result = await build({
  entryPoints: ['src/ui/view.mjs'],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  outfile: 'view.js',
  write: false,
});
const js = result.outputFiles.find((file) => file.path.endsWith('.js')).text;
const css = result.outputFiles.find((file) => file.path.endsWith('.css')).text;
let html = await readFile('src/ui/view.html', 'utf8');
for (const [slot, markup] of [
  ['<style id="widget-css"></style>', `<style>${css}</style>`],
  [
    '<script id="widget-js"></script>',
    `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`,
  ],
]) {
  if (!html.includes(slot)) throw new Error(`Missing widget slot: ${slot}`);
  html = html.replace(slot, () => markup);
}
await mkdir('build/src/ui', { recursive: true });
await writeFile('build/src/ui/view.html', html);
