#!/usr/bin/env node
// Build the console SPA (spec 04, M4).
//
//   node scripts/build-web.mjs [--watch]
//
// esbuild bundles web/src/main.tsx → web/dist/main.js (+ main.css) and copies index.html.
// esbuild is already a devDependency (NodejsFunction uses it), so the SPA adds no new build
// tooling. Output is what WebStack uploads to S3; a missing web/dist makes the asset
// deployment a no-op so credential-less `cdk synth` still works (see lib/web-stack.ts).
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(repoRoot, 'web');
const outDir = path.join(webDir, 'dist');
const watch = process.argv.includes('--watch');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(webDir, 'src', 'main.tsx')],
  bundle: true,
  outfile: path.join(outDir, 'main.js'),
  format: 'esm',
  target: ['es2022'],
  platform: 'browser',
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  logLevel: 'info',
};

fs.copyFileSync(path.join(webDir, 'index.html'), path.join(outDir, 'index.html'));

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log(`watching web/src → ${path.relative(repoRoot, outDir)}`);
} else {
  await esbuild.build(options);
  const files = fs.readdirSync(outDir).sort();
  console.log(`built console → ${path.relative(repoRoot, outDir)} (${files.join(', ')})`);
}
