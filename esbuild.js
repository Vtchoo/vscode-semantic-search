const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // These are kept as external so their native binaries work at runtime
  external: [
    'vscode',
    '@lancedb/lancedb',
    '@huggingface/transformers',
    'onnxruntime-node',
    'onnxruntime-web',
    'ignore',
    // Optional native deps that onnxruntime-node may try to load
    'sharp',
    'canvas',
  ],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

if (watch) {
  esbuild.context(buildOptions).then((ctx) => {
    ctx.watch();
    console.log('[esbuild] watching for changes...');
  });
} else {
  esbuild.build(buildOptions).catch(() => process.exit(1));
}
