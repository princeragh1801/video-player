// FFmpeg → HLS adaptive ladder. One decode, split into every rendition in a single ffmpeg run.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Ladder (height, video kbps, audio kbps). `level` is only the CODECS hint in the master playlist
// (x264 picks the real level). Only rungs <= source height are produced.
export const LADDER = [
  { name: '240p', height: 240, vbr: 400, abr: 64, level: '3.0' },
  { name: '360p', height: 360, vbr: 800, abr: 96, level: '3.0' },
  { name: '480p', height: 480, vbr: 1400, abr: 128, level: '3.1' },
  { name: '720p', height: 720, vbr: 2800, abr: 128, level: '4.0' },
  { name: '1080p', height: 1080, vbr: 5000, abr: 160, level: '4.2' },
];

const SEGMENT_SECONDS = 6;
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function run(cmd, args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      if (onStdout) onStdout(s);
      else stdout += s;
    });
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-2000)}`))));
  });
}

export async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(out);
  const video = info.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!video) throw new Error('No video stream found in upload');
  let { width, height } = video;
  // Respect rotation metadata (phone videos): ffmpeg auto-rotates, so swap dimensions accordingly.
  const rotation = Math.abs(Number(video.tags?.rotate ?? video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0));
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  return {
    width,
    height,
    duration: Number(info.format.duration ?? video.duration ?? 0),
    hasAudio: info.streams.some((s) => s.codec_type === 'audio'),
  };
}

export function planRenditions({ width, height }) {
  let rungs = LADDER.filter((r) => r.height <= height);
  // Tiny source: one rendition at native size.
  if (rungs.length === 0) rungs = [{ ...LADDER[0], name: `${even(height)}p`.padStart(4, '0'), height: even(height) }];
  return rungs.map((r) => ({ ...r, width: even((width * r.height) / height) }));
}

export async function transcodeToHls({ input, outDir, meta, renditions, onProgress }) {
  const n = renditions.length;
  const filter =
    `[0:v]split=${n}${renditions.map((_, i) => `[s${i}]`).join('')};` +
    renditions.map((r, i) => `[s${i}]scale=${r.width}:${r.height}:flags=bicubic,format=yuv420p[v${i}]`).join(';');

  const args = ['-hide_banner', '-nostdin', '-y', '-i', input, '-filter_complex', filter];
  for (const [i, r] of renditions.entries()) {
    const dir = path.join(outDir, r.name);
    await mkdir(dir, { recursive: true });
    args.push('-map', `[v${i}]`);
    if (meta.hasAudio) args.push('-map', '0:a:0');
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main',
      '-b:v', `${r.vbr}k`, '-maxrate', `${Math.round(r.vbr * 1.07)}k`, '-bufsize', `${r.vbr * 2}k`,
      // Fixed 2s GOPs, no scene-cut keyframes → segment boundaries align across renditions for clean ABR switches.
      '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0',
    );
    if (meta.hasAudio) args.push('-c:a', 'aac', '-b:a', `${r.abr}k`, '-ac', '2', '-ar', '48000');
    args.push(
      '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments', '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
      path.join(dir, 'index.m3u8'),
    );
  }
  args.push('-progress', 'pipe:1', '-nostats');

  let lastPct = -1;
  await run('ffmpeg', args, {
    onStdout: (chunk) => {
      const m = [...chunk.matchAll(/out_time_us=(\d+)/g)].pop();
      if (!m || !meta.duration) return;
      const pct = Math.min(99, Math.floor((Number(m[1]) / 1e6 / meta.duration) * 100));
      if (pct > lastPct) onProgress?.((lastPct = pct));
    },
  });

  await writeFile(path.join(outDir, 'master.m3u8'), masterPlaylist(renditions, meta.hasAudio));
}

export function masterPlaylist(renditions, hasAudio) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const r of renditions) {
    const level = Math.round(Number(r.level) * 10).toString(16).padStart(2, '0');
    const codecs = [`avc1.4d40${level}`, ...(hasAudio ? ['mp4a.40.2'] : [])].join(',');
    const bw = (r.vbr + (hasAudio ? r.abr : 0)) * 1000;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(bw * 1.1)},AVERAGE-BANDWIDTH=${bw},RESOLUTION=${r.width}x${r.height},CODECS="${codecs}"`,
      `${r.name}/index.m3u8`,
    );
  }
  return lines.join('\n') + '\n';
}
