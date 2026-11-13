import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: { extension: 'src/extension.ts', worker: 'src/engine/worker.ts' },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outdir: 'dist',
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'info',
});
if (watch) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
