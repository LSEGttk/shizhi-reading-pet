import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const keyDir = resolve('.private');
const keyFile = join(keyDir, 'reading-pet.pem');
await mkdir(keyDir, { recursive: true, mode: 0o700 });
await chmod(keyDir, 0o700);
try {
  await readFile(keyFile);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  await writeFile(keyFile, privateKey, { mode: 0o600, flag: 'wx' });
}
await chmod(keyFile, 0o600);
const key = createPrivateKey(await readFile(keyFile));
const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
const extensionId = [...createHash('sha256').update(publicKey).digest().subarray(0, 16)]
  .map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const temp = await mkdtemp(join(tmpdir(), 'reading-pet-pack-'));
try {
  const payload = join(temp, 'payload');
  await cp('dist', payload, { recursive: true });
  execFileSync(process.env.READING_PET_CHROME || '/usr/bin/google-chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${join(temp, 'profile')}`,
    `--pack-extension=${payload}`, `--pack-extension-key=${keyFile}`,
  ], { timeout: 30000, stdio: 'pipe' });
  const bytes = await readFile(`${payload}.crx`);
  if (bytes.toString('ascii', 0, 4) !== 'Cr24' || bytes.readUInt32LE(4) !== 3) throw new Error('Chrome 没有生成有效的 CRX3 包。');
  const zipOffset = 12 + bytes.readUInt32LE(8);
  if (bytes.readUInt32LE(zipOffset) !== 0x04034b50) throw new Error('CRX 中没有有效的 ZIP 内容。');
  await mkdir('artifacts', { recursive: true });
  const output = `artifacts/reading-pet-${manifest.version}.crx`;
  await writeFile(output, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(`${output}.sha256`, `${sha256}  reading-pet-${manifest.version}.crx\n`);
  await writeFile('artifacts/crx-info.json', JSON.stringify({ format: 'CRX3', extensionId, version: manifest.version, bytes: bytes.length, sha256, signingKey: '.private/reading-pet.pem (not included in package)' }, null, 2));
  console.log(`${output}\n扩展 ID：${extensionId}\n签名私钥保留在 .private/，不包含在安装包中。`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
