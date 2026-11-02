import { build } from 'esbuild';
import { mkdir, cp, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/background.ts', 'src/panel.ts', 'src/options.ts'], bundle: true, outdir: 'dist', format: 'esm', target: 'chrome116', minify: true });
await build({ entryPoints: ['src/content.ts'], bundle: true, outfile: 'dist/content.js', format: 'iife', target: 'chrome116', minify: true });
await build({ entryPoints: ['src/rich/frame.ts'], bundle: true, outfile: 'dist/rich-frame.js', format: 'iife', target: 'chrome116', minify: true });
for (const file of ['manifest.json', 'panel.html', 'options.html', 'styles.css', 'rich.css', 'rich-frame.html', 'rich-frame.css', 'skills', 'assets', 'THIRD_PARTY_NOTICES.md']) {
  await cp(file, `dist/${file}`, { recursive: true });
}
await cp('third_party/dsh-pet-dafeiyu/LICENSE', 'dist/assets/UPSTREAM-LICENSE.txt');
await cp('node_modules/@mozilla/readability/LICENSE.md', 'dist/assets/READABILITY-LICENSE.txt');
await mkdir('dist/vendor', { recursive: true });
await cp('node_modules/mermaid/dist/mermaid.min.js', 'dist/vendor/mermaid.min.js');
await cp('node_modules/katex/dist/katex.min.css', 'dist/vendor/katex.min.css');
await cp('node_modules/katex/dist/fonts', 'dist/vendor/fonts', { recursive: true });
for (const name of ['dompurify', 'katex', 'markdown-it', 'highlight.js', 'mermaid']) await cp(`node_modules/${name}/LICENSE`, `dist/vendor/${name}-LICENSE.txt`);
console.log('已构建 dist/，可以在浏览器中加载已解压的扩展。');
