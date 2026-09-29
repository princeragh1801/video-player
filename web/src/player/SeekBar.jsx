import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { fmtTime } from '@/lib/format';

// Slim scrubber: grows on hover, shows buffered ranges, a hover ghost + time preview, and supports
// click, drag and keyboard seeking.
export function SeekBar({ time, duration, buffered, onSeek }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null); // 0..1
  const [drag, setDrag] = useState(null); // 0..1 while dragging

  const ratioAt = (clientX) => {
    const r = ref.current.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const pct = (t) => (duration ? `${(Math.min(t, duration) / duration) * 100}%` : '0%');
  const played = drag ?? (duration ? time / duration : 0);
  const active = hover !== null || drag !== null;

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.floor(duration) || 0}
      aria-valuenow={Math.floor(time)}
      aria-valuetext={`${fmtTime(time)} of ${fmtTime(duration)}`}
      className="group/seek relative flex h-5 cursor-pointer touch-none items-center outline-none"
      onPointerMove={(e) => {
        const r = ratioAt(e.clientX);
        setHover(r);
        if (drag !== null) setDrag(r);
      }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(ratioAt(e.clientX));
      }}
      onPointerUp={(e) => {
        if (drag === null) return;
        onSeek(ratioAt(e.clientX) * duration);
        setDrag(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation(), onSeek(time + (e.key === 'ArrowRight' ? 5 : -5));
        if (e.key === 'Home') onSeek(0);
        if (e.key === 'End') onSeek(duration);
      }}
    >
      <div
        className={cn(
          'relative h-1 w-full overflow-hidden rounded-full bg-white/20 transition-[height] duration-150',
          active && 'h-1.5',
        )}
      >
        {buffered.map(([s, e]) => (
          <div key={s} className="absolute inset-y-0 bg-white/35" style={{ left: pct(s), width: `calc(${pct(e)} - ${pct(s)})` }} />
        ))}
        {hover !== null && <div className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${hover * 100}%` }} />}
        <div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${played * 100}%` }} />
      </div>

      <div
        className={cn(
          'absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-white shadow-md ring-4 ring-brand/30 transition-transform duration-150 group-focus-visible/seek:scale-100',
          active && 'scale-100',
        )}
        style={{ left: `${played * 100}%` }}
      />

      {hover !== null && duration > 0 && (
        <div
          className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-md border border-white/10 bg-black/85 px-2 py-1 font-mono text-xs tabular-nums text-white shadow-lg backdrop-blur"
          style={{ left: `clamp(24px, ${hover * 100}%, calc(100% - 24px))` }}
        >
          {fmtTime((drag ?? hover) * duration)}
        </div>
      )}
    </div>
  );
}
