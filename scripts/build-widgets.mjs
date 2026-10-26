import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

const { outputFiles } = await build({
  entryPoints: ['src/ui/replay.mjs'],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  outfile: 'replay.js',
  write: false,
});
const js = outputFiles
  .find((file) => file.path.endsWith('.js'))
  .text.replace(/<\/script/gi, '<\\/script');
const css = outputFiles.find((file) => file.path.endsWith('.css')).text;
await mkdir('build/src/ui', { recursive: true });
await writeFile(
  'build/src/ui/replay.html',
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Browserless Session Replay</title><style>${css}
:root{color-scheme:light dark}body{margin:0;padding:16px;font:14px system-ui;background:light-dark(#fff,#171717);color:light-dark(#222,#eee)}
#status{margin:0 0 12px;overflow-wrap:anywhere}.rr-player{box-shadow:none;max-width:100%}
.rr-player .rr-controller{background:light-dark(#fff,#202020)!important;color:inherit}.rr-player .rr-controller__btns button{color:inherit!important}.rr-player .rr-controller__btns button.active{color:white!important}
.rr-player .rr-timeline__time{color:inherit!important}.rr-player .rr-controller svg{fill:currentColor}
</style></head><body><p id="status" role="status">Loading session replay…</p><div id="player"></div><script>${js}</script></body></html>`,
);
