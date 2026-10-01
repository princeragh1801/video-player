// FFmpeg → HLS adaptive ladder. One decode, split into every rendition in a single ffmpeg run.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Ladder for ~30fps sources, keyed by the short side (p) so portrait video is graded like landscape.
// Only rungs <= the source's short side are produced: a 4K upload gets every rung, a 720p upload
// stops at 720p. Video kbps is scaled up for high frame rates and capped by the source's own bitrate.
export const LADDER = [
  { p: 240, vbr: 400, abr: 64 },
  { p: 360, vbr: 800, abr: 96 },
  { p: 480, vbr: 1400, abr: 128 },
  { p: 720, vbr: 2800, abr: 128 },
  { p: 1080, vbr: 5000, abr: 160 },
  { p: 1440, vbr: 9000, abr: 192 },
  { p: 2160, vbr: 16000, abr: 192 },
];
const MAX_P = LADDER.at(-1).p;
const MAX_FPS = 60;
// A source this far above its nearest rung (e.g. 900p, 1600p) also gets a rendition at native size.
const NATIVE_RUNG_MARGIN = 1.15;
// H.264 re-encode headroom over the source bitrate (sources are often HEVC/AV1, which are more efficient).
const SOURCE_BITRATE_HEADROOM = 1.5;

// [level, max macroblocks/s, max frame size in macroblocks, max kbps (Main profile)]
const H264_LEVELS = [
  ['3.0', 40500, 1620, 10000], ['3.1', 108000, 3600, 14000], ['3.2', 216000, 5120, 20000],
  ['4.0', 245760, 8192, 20000], ['4.1', 245760, 8192, 50000], ['4.2', 522240, 8704, 50000],
  ['5.0', 589824, 22080, 135000], ['5.1', 983040, 36864, 240000], ['5.2', 2073600, 36864, 240000],
];

function h264Level(width, height, fps, kbps) {
  const frameMbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const fit = H264_LEVELS.find(([, mbps, fs, br]) => frameMbs <= fs && frameMbs * fps <= mbps && kbps <= br);
  return (fit ?? H264_LEVELS.at(-1))[0];
}

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
  const audio = info.streams.filter((s) => s.codec_type === 'audio');
  // Per-stream bit_rate is often missing (MKV/WebM); fall back to the container total minus audio.
  const audioBps = audio.reduce((sum, s) => sum + (Number(s.bit_rate) || 0), 0);
  const videoBps = Number(video.bit_rate) || (Number(info.format.bit_rate) || 0) - audioBps;
  return {
    width,
    height,
    fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 30,
    videoKbps: videoBps > 0 ? Math.round(videoBps / 1000) : null,
    duration: Number(info.format.duration ?? video.duration ?? 0),
    hasAudio: audio.length > 0,
  };
}

function parseRate(rate) {
  const [num, den = 1] = String(rate ?? '').split('/').map(Number);
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 && fps < 1000 ? fps : 0;
}

export function planRenditions({ width, height, fps, videoKbps }) {
  const short = Math.min(width, height);
  const outFps = Math.min(fps || 30, MAX_FPS);
  const hfr = outFps > 31 ? 1.5 : 1;

  const rungs = LADDER.filter((r) => r.p <= short);
  const top = rungs.at(-1);
  if (short <= MAX_P && (!top || short > top.p * NATIVE_RUNG_MARGIN)) {
    // Bitrate scales with pixel count from the nearest rung below (or the bottom rung for tiny sources).
    const ref = top ?? LADDER[0];
    const nativeP = even(short);
    rungs.push({ p: nativeP, vbr: Math.max(150, Math.round((ref.vbr * (nativeP / ref.p) ** 2) / 50) * 50), abr: ref.abr });
  }

  return rungs.map((r) => {
    const scale = r.p / short;
    const w = even(width * scale);
    const h = even(height * scale);
    let vbr = Math.round(r.vbr * hfr);
    // Don't spend more bits than the source has detail for; the floor guards against bogus metadata.
    if (videoKbps) vbr = Math.max(Math.round(vbr / 2), Math.min(vbr, Math.round(videoKbps * SOURCE_BITRATE_HEADROOM)));
    return {
      name: `${r.p}p`.padStart(4, '0'),
      width: w,
      height: h,
      fps: outFps,
      vbr,
      abr: r.abr,
      level: h264Level(w, h, outFps, Math.round(vbr * 1.07)),
    };
  });
}

export async function transcodeToHls({ input, outDir, meta, renditions, onProgress }) {
  const n = renditions.length;
  // Sources above MAX_FPS (e.g. 120fps phone clips) are brought down to it once, before the split.
  const fpsFilter = meta.fps > MAX_FPS ? `fps=${MAX_FPS},` : '';
  const filter =
    `[0:v]${fpsFilter}split=${n}${renditions.map((_, i) => `[s${i}]`).join('')};` +
    renditions.map((r, i) => `[s${i}]scale=${r.width}:${r.height}:flags=bicubic,format=yuv420p[v${i}]`).join(';');

  const args = ['-hide_banner', '-nostdin', '-y', '-i', input, '-filter_complex', filter];
  for (const [i, r] of renditions.entries()) {
    const dir = path.join(outDir, r.name);
    await mkdir(dir, { recursive: true });
    args.push('-map', `[v${i}]`);
    if (meta.hasAudio) args.push('-map', '0:a:0');
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-level:v', r.level,
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
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(bw * 1.1)},AVERAGE-BANDWIDTH=${bw},RESOLUTION=${r.width}x${r.height},FRAME-RATE=${r.fps.toFixed(3)},CODECS="${codecs}"`,
      `${r.name}/index.m3u8`,
    );
  }
  return lines.join('\n') + '\n';
}
