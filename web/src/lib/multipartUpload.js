// Uploads a File straight to R2 in parallel parts using presigned URLs from the API.
import { api } from './api.js';

const CONCURRENCY = 4;
const BATCH = 20;
const RETRIES = 3;

function putPart(url, blob, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag');
        if (!etag) return reject(new Error('Missing ETag — bucket CORS must expose the ETag header'));
        resolve(etag);
      } else reject(new Error(`Part upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

export async function uploadVideo(file, meta, { onProgress, signal } = {}) {
  const init = await api('/api/uploads', {
    method: 'POST',
    body: { ...meta, fileSize: file.size, contentType: file.type || 'video/mp4' },
  });
  const { videoId, partSize, partCount } = init;
  const loaded = new Array(partCount).fill(0);
  const report = () => onProgress?.(loaded.reduce((a, b) => a + b, 0) / file.size);
  const etags = [];
  const urls = new Map(); // partNumber -> Promise<presigned url>

  // Presign in batches; concurrent lanes share the same in-flight batch request.
  function urlFor(partNumber) {
    if (!urls.has(partNumber)) {
      const nums = [];
      for (let n = partNumber; n < partNumber + BATCH && n <= partCount && !urls.has(n); n++) nums.push(n);
      const req = api(`/api/uploads/${videoId}/parts`, { method: 'POST', body: { partNumbers: nums } }).then(
        (r) => new Map(r.urls.map((u) => [u.partNumber, u.url])),
      );
      nums.forEach((n) => urls.set(n, req.then((m) => m.get(n))));
    }
    return urls.get(partNumber);
  }

  let next = 1;
  async function lane() {
    while (next <= partCount) {
      const partNumber = next++;
      const blob = file.slice((partNumber - 1) * partSize, partNumber * partSize);
      for (let attempt = 1; ; attempt++) {
        try {
          const etag = await putPart(await urlFor(partNumber), blob, (b) => ((loaded[partNumber - 1] = b), report()), signal);
          etags.push({ partNumber, etag });
          break;
        } catch (err) {
          if (err.name === 'AbortError' || attempt >= RETRIES) throw err;
          urls.delete(partNumber); // URL may have expired; fetch a fresh one
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, partCount) }, lane));
  } catch (err) {
    await api(`/api/uploads/${videoId}/abort`, { method: 'POST' }).catch(() => {});
    throw err;
  }
  return api(`/api/uploads/${videoId}/complete`, { method: 'POST', body: { parts: etags } });
}
