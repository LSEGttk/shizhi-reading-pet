import { permissionOrigin } from './chat';
import { getSettings, saveMedia } from '../storage/local';
import { safeImageUrl } from '../rich/schema';

export function imageEndpoint(base: string): URL {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash) throw new Error('图片接口地址不能包含账号、查询参数或锚点。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('图片接口需使用 HTTPS；本地服务可用 localhost HTTP。');
  url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/images\/generations$/, '')}/images/generations`;
  return url;
}
const MAX_BYTES = 12 * 1024 * 1024;
async function limitedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body || Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('图片响应为空或超过大小上限。'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error('图片响应超过大小上限。'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0; for (const part of chunks) { bytes.set(part, at); at += part.length; } return bytes;
}
function imageType(bytes: Uint8Array): string {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  throw new Error('图片接口未返回受支持的 PNG、JPEG 或 WebP 图片。');
}
export async function generateImage(prompt: string, alt: string, signal: AbortSignal): Promise<string> {
  const settings = (await getSettings()).image;
  if (!settings?.enabled || !settings.baseUrl || !settings.model) throw new Error('先在模型设置中连接并启用图片接口。');
  if (!prompt.trim() || prompt.length > 2500) throw new Error('图片描述需在 1～2500 字之间。');
  const controller = new AbortController(), abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, 180000);
  try {
    const url = imageEndpoint(settings.baseUrl);
    if (!await chrome.permissions.contains({ origins: [permissionOrigin(url)] })) throw new Error('请在设置中保存并授权图片接口域名。');
    const response = await fetch(url, { method: 'POST', signal: controller.signal, redirect: 'error', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) }, body: JSON.stringify({ model: settings.model, prompt, n: 1, size: settings.size || '1024x1024' }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`图片接口返回 HTTP ${response.status}，请检查图片模型、密钥和额度。`); }
    const data = JSON.parse(new TextDecoder().decode(await limitedBody(response, MAX_BYTES * 1.5))), item = data.data?.[0];
    let bytes: Uint8Array;
    if (typeof item?.b64_json === 'string' && item.b64_json.length <= MAX_BYTES * 1.4 && /^[A-Za-z0-9+/=\r\n]+$/.test(item.b64_json)) {
      const raw = atob(item.b64_json); bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    } else if (typeof item?.url === 'string' && safeImageUrl(item.url)) {
      const imageUrl = new URL(item.url);
      // No API credentials are sent to a returned image address. Grant other download hosts explicitly in settings.
      if (imageUrl.origin !== url.origin && !await chrome.permissions.contains({ origins: [permissionOrigin(imageUrl)] })) throw new Error(`图片已生成，但下载域名未授权：${imageUrl.origin}。请在图片设置授权此域名；本次未自动重复生成。`);
      const image = await fetch(imageUrl, { signal: controller.signal, redirect: 'error', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!image.ok) { await image.body?.cancel(); throw new Error('图片已生成，但下载失败；未自动重复生成。'); }
      bytes = await limitedBody(image, MAX_BYTES);
    } else throw new Error('图片接口返回格式不兼容，需要 data[0].b64_json 或 HTTPS url。');
    if (bytes.length > MAX_BYTES) throw new Error('图片超过 12 MB 上限。');
    const mime = imageType(bytes), blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
    // Validate the actual bitmap instead of accepting a forged file signature.
    const bitmap = await createImageBitmap(blob); if (bitmap.width * bitmap.height > 40_000_000) { bitmap.close(); throw new Error('图片像素尺寸过大。'); } bitmap.close();
    controller.signal.throwIfAborted();
    const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = () => reject(new Error('无法保存图片。')); reader.readAsDataURL(blob); });
    const id = `media-${crypto.randomUUID()}`;
    await saveMedia({ id, url: dataUrl, alt: alt.slice(0, 300), createdAt: new Date().toISOString(), generated: true });
    return id;
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) throw new Error('图片生成超时，未自动重试。服务商已受理的请求仍可能产生用量。');
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
