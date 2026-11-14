import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = { bundle: true, outdir: 'dist', minify: production, sourcemap: !production, sourcesContent: false, logLevel: 'info' };

// extension host + engine worker (Node)
const host = await esbuild.context({
  ...common,
  entryPoints: { extension: 'src/extension.ts', worker: 'src/engine/worker.ts' },
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
});

// webview: ES modules in webview/*.js plus the typed pure helpers in webview/lib/*.ts → one script
const webview = await esbuild.context({
  ...common,
  entryPoints: { webview: 'webview/main.js' },
  format: 'iife',
  platform: 'browser',
  target: 'chrome108',
});

const contexts = [host, webview];
if (watch) await Promise.all(contexts.map((c) => c.watch()));
else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
