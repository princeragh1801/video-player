export function fmtTime(t) {
  if (!Number.isFinite(t)) return '0:00';
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return h ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}
