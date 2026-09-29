// End-to-end check of upload → transcode → secure playback, including the negative security cases.
// Usage: node scripts/e2e.mjs <video.mp4> [baseUrl=http://localhost:8080] [storageEndpoint]
// Requires seeded users (npm run seed).
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const [file, BASE = 'http://localhost:8080', STORAGE] = process.argv.slice(2);
const ORIGIN = BASE;
let failures = 0;

async function call(path, { method = 'GET', token, body, raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Origin: ORIGIN, ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  if (raw) return res;
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data };
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

const login = async (email) => (await call('/api/auth/login', { method: 'POST', body: { email, password: 'password1234' } })).data.accessToken;

console.log('auth');
const instructor = await login('instructor@example.com');
const student = await login('student@example.com');
const outsider = await login('outsider@example.com');
await check('bad password rejected', async () => {
  const r = await call('/api/auth/login', { method: 'POST', body: { email: 'student@example.com', password: 'nope' } });
  assert.equal(r.status, 401);
});
await check('students cannot upload', async () => {
  const r = await call('/api/uploads', { method: 'POST', token: student, body: {} });
  assert.equal(r.status, 403);
});

console.log('upload (direct to storage)');
const bytes = await readFile(file);
const { data: { courses } } = await call('/api/courses', { token: instructor });
const course = courses.find((c) => c.canManage);
const init = await call('/api/uploads', {
  method: 'POST', token: instructor,
  body: { title: `E2E ${new Date().toISOString()}`, courseId: course.id, access: 'course', fileSize: bytes.length, contentType: 'video/mp4' },
});
assert.equal(init.status, 201, JSON.stringify(init.data));
const { videoId, partSize, partCount } = init.data;
const { data: { urls } } = await call(`/api/uploads/${videoId}/parts`, {
  method: 'POST', token: instructor, body: { partNumbers: Array.from({ length: partCount }, (_, i) => i + 1) },
});
await check('presigned URLs are part uploads only (no GET of source)', () => {
  for (const u of urls) assert.match(u.url, /uploadId=.*partNumber=|partNumber=.*uploadId=/);
});
const parts = [];
for (const { partNumber, url } of urls) {
  const r = await fetch(url, { method: 'PUT', body: bytes.subarray((partNumber - 1) * partSize, partNumber * partSize), headers: { Origin: ORIGIN } });
  assert.equal(r.status, 200, `part ${partNumber}: ${r.status} ${await r.text()}`);
  parts.push({ partNumber, etag: r.headers.get('etag') });
}
const done = await call(`/api/uploads/${videoId}/complete`, { method: 'POST', token: instructor, body: { parts } });
assert.equal(done.status, 200, JSON.stringify(done.data));
await check('double complete is rejected', async () => {
  const r = await call(`/api/uploads/${videoId}/complete`, { method: 'POST', token: instructor, body: { parts } });
  assert.equal(r.status, 409);
});

console.log('processing');
let video;
for (let i = 0; i < 180; i++) {
  video = (await call(`/api/videos/${videoId}`, { token: instructor })).data.video;
  if (video.status === 'READY' || video.status === 'FAILED') break;
  await new Promise((r) => setTimeout(r, 2000));
}
await check(`video READY (${video.qualities?.join(', ')})`, () => assert.equal(video.status, 'READY', video.error));
await check('API never exposes storage keys', () => {
  const s = JSON.stringify(video);
  assert.ok(!s.includes('sources/') && !s.includes('hls/'), s);
});

console.log('authorization');
await check('non-enrolled user cannot see or start playback', async () => {
  assert.equal((await call(`/api/videos/${videoId}`, { token: outsider })).status, 404);
  const r = await call('/api/playback', { method: 'POST', token: outsider, body: { videoId, deviceId: randomUUID() } });
  assert.equal(r.status, 404);
});
await check('unauthenticated playback start rejected', async () => {
  assert.equal((await call('/api/playback', { method: 'POST', body: { videoId, deviceId: randomUUID() } })).status, 401);
});

console.log('secure playback');
const deviceA = randomUUID();
const start = await call('/api/playback', { method: 'POST', token: student, body: { videoId, deviceId: deviceA } });
assert.equal(start.status, 201, JSON.stringify(start.data));
const pb = start.data;
const base = `/api/playback/${pb.sessionId}`;
const master = await call(`${base}/master.m3u8`, { token: pb.token, raw: true });
const masterText = await master.text();
const variant = masterText.split('\n').find((l) => l.endsWith('.m3u8'));
const variantText = await (await call(`${base}/${variant}`, { token: pb.token, raw: true })).text();
const seg = variantText.split('\n').find((l) => l.endsWith('.ts'));
const segUrl = `${base}/${variant.split('/')[0]}/${seg}`;

await check('master playlist lists renditions with relative URIs', () => {
  assert.equal(master.status, 200);
  assert.match(masterText, /#EXT-X-STREAM-INF/);
  assert.ok(!/https?:\/\//.test(masterText), 'absolute URL in playlist');
});
await check('segment served with playback token', async () => {
  const r = await call(segUrl, { token: pb.token, raw: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp2t');
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.ok((await r.arrayBuffer()).byteLength > 1000);
});
await check('copied segment/playlist URL without token → 401', async () => {
  assert.equal((await call(segUrl, { raw: true })).status, 401);
  assert.equal((await call(`${base}/master.m3u8`, { raw: true })).status, 401);
});
await check('API access token is not accepted as a playback token', async () => {
  assert.equal((await call(segUrl, { token: student, raw: true })).status, 401);
});
await check('token for one session cannot be used on another session URL', async () => {
  const other = await call('/api/playback', { method: 'POST', token: instructor, body: { videoId, deviceId: randomUUID() } });
  assert.equal((await call(`/api/playback/${other.data.sessionId}/master.m3u8`, { token: pb.token, raw: true })).status, 401);
  await call(`/api/playback/${other.data.sessionId}/end`, { method: 'POST', token: other.data.token });
});
await check('path traversal / unknown files rejected', async () => {
  for (const p of [`${base}/720p/..%2F..%2Fsources`, `${base}/9999p/index.m3u8`, `${base}/${variant.split('/')[0]}/source.mp4`]) {
    const s = (await call(p, { token: pb.token, raw: true })).status;
    assert.ok(s === 404 || s === 400, `${p} → ${s}`);
  }
});
if (STORAGE) {
  await check('bucket is private: anonymous GET of HLS and source objects denied', async () => {
    for (const k of [`hls/${videoId}/master.m3u8`, `sources/${videoId}/original`]) {
      const s = (await fetch(`${STORAGE}/videos/${k}`)).status;
      assert.ok(s === 403 || s === 401, `${k} → ${s}`);
    }
  });
}
await check('heartbeat rotates the playback token', async () => {
  await new Promise((r) => setTimeout(r, 1100)); // new iat → new token
  const r = await call(`${base}/heartbeat`, { method: 'POST', token: pb.token, body: { position: 3 } });
  assert.equal(r.status, 200);
  assert.notEqual(r.data.token, pb.token);
});

console.log('concurrent-stream limit (2)');
const deviceB = await call('/api/playback', { method: 'POST', token: student, body: { videoId, deviceId: randomUUID() } });
await check('second device allowed', () => assert.equal(deviceB.status, 201));
await check('third device blocked with session list', async () => {
  const r = await call('/api/playback', { method: 'POST', token: student, body: { videoId, deviceId: randomUUID() } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'CONCURRENT_LIMIT');
  assert.equal(r.data.sessions.length, 2);
});
await check('same device reopening replaces its old session (no slot used)', async () => {
  const r = await call('/api/playback', { method: 'POST', token: student, body: { videoId, deviceId: deviceA } });
  assert.equal(r.status, 201);
  await new Promise((res) => setTimeout(res, 5500)); // session cache TTL
  assert.equal((await call(`${base}/master.m3u8`, { token: pb.token, raw: true })).status, 401, 'old session still works');
  pb.replacement = r.data;
});

console.log('revocation');
await check('revoking enrollment kills active playback', async () => {
  const me = (await call('/api/auth/me', { token: student })).data.user;
  await call(`/api/courses/${course.id}/enrollments/${me.id}`, { method: 'DELETE', token: instructor });
  await new Promise((r) => setTimeout(r, 5500));
  const { sessionId, token } = pb.replacement;
  assert.equal((await call(`/api/playback/${sessionId}/master.m3u8`, { token, raw: true })).status, 401);
  assert.equal((await call(`/api/videos/${videoId}`, { token: student })).status, 404);
  // restore for future runs
  await call(`/api/courses/${course.id}/enrollments`, { method: 'POST', token: instructor, body: { email: 'student@example.com' } });
});
await call(`/api/playback/${deviceB.data.sessionId}/end`, { method: 'POST', token: deviceB.data.token });

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
