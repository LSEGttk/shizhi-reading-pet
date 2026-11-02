import { execFileSync } from 'node:child_process';
import { mkdir, rm, readFile } from 'node:fs/promises';
await mkdir('artifacts', { recursive: true });
const { version } = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const name = `reading-pet-${version}.zip`;
await rm(`artifacts/${name}`, { force: true });
execFileSync('zip', ['-qr', `../artifacts/${name}`, '.'], { cwd: 'dist' });
console.log(`artifacts/${name}`);
