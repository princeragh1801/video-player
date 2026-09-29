import { useEffect, useState } from 'react';

// Visible, moving, per-account watermark to discourage screen recording and make leaks traceable.
// It's a deterrent, not DRM: a determined user can hide DOM nodes. Burned-in / forensic
// watermarking would happen server-side (see README).
export function Watermark({ text }) {
  const [pos, setPos] = useState({ top: 12, left: 8 });
  useEffect(() => {
    const move = () => setPos({ top: 10 + Math.random() * 70, left: 5 + Math.random() * 60 });
    move();
    const id = setInterval(move, 7000);
    return () => clearInterval(id);
  }, []);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-[5] whitespace-nowrap font-mono text-[11px] font-medium tracking-wide text-white/30 transition-all duration-[2000ms] ease-in-out [text-shadow:0_0_2px_rgb(0_0_0/0.6)] sm:text-xs"
      style={{ top: `${pos.top}%`, left: `${pos.left}%` }}
    >
      {text}
    </div>
  );
}
