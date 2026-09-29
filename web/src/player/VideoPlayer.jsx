import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  Check, Gauge, Loader2, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, Settings, SlidersHorizontal,
  Volume1, Volume2, VolumeX, MonitorSmartphone, ShieldAlert,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { usePlaybackSession } from './usePlaybackSession.js';
import { Watermark } from './Watermark.jsx';
import { SeekBar } from './SeekBar.jsx';
import { fmtTime } from '@/lib/format';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SKIP = 10;

// Glass-style icon button with a tooltip that stays inside the player (fullscreen-safe).
function ControlButton({ label, onClick, container, children, className, ...props }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClick}
          aria-label={label}
          className={cn('size-9 rounded-full text-white hover:bg-white/15 hover:text-white [&_svg]:size-5', className)}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent container={container} side="top" sideOffset={8} className="border border-white/10 bg-black/85 text-white backdrop-blur">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function VideoPlayer({ videoId, title }) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const hlsRef = useRef(null);
  const resume = useRef({ time: 0, playing: false });

  const getPosition = useCallback(() => videoRef.current?.currentTime ?? 0, []);
  const pb = usePlaybackSession(videoId, getPosition);

  const [container, setContainer] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState([]);
  const [buffering, setBuffering] = useState(true);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [levels, setLevels] = useState([]);
  const [autoQuality, setAutoQuality] = useState(true);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [fatal, setFatal] = useState(null);
  const [bandwidth, setBandwidth] = useState(0);
  const [flash, setFlash] = useState(null); // { icon, key } — brief center feedback

  const { getToken, restart } = pb;

  // ------------------------------------------------------------------ HLS.js wiring
  useEffect(() => {
    if (pb.status !== 'ready') return;
    const video = videoRef.current;
    if (!Hls.isSupported()) {
      // Native HLS (older iOS) can't attach our Authorization header, so it isn't supported.
      setFatal('This browser does not support secure streaming. Please use a recent Chrome, Edge, Firefox or Safari.');
      return;
    }
    setFatal(null);
    const hls = new Hls({
      // Every playlist/segment request carries the short-lived playback token in a header —
      // never in the URL — so copied URLs don't play anywhere else.
      xhrSetup: async (xhr, url) => {
        const token = await getToken();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      },
      capLevelToPlayerSize: true, // Auto mode won't fetch 1080p into a small player
      maxBufferLength: 30,
      maxMaxBufferLength: 60, // don't prefetch far ahead (also limits bulk scraping per session)
      backBufferLength: 30,
    });
    hlsRef.current = hls;
    let networkRetries = 0;

    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      setLevels(data.levels.map((l, index) => ({ index, height: l.height, bitrate: l.bitrate })));
      if (resume.current.time) video.currentTime = resume.current.time;
      if (resume.current.playing) video.play().catch(() => {});
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => setCurrentLevel(data.level));
    hls.on(Hls.Events.FRAG_LOADED, () => {
      networkRetries = 0;
      setBandwidth(hls.bandwidthEstimate);
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      const code = data.response?.code;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (code === 401) {
          // Session/token died (e.g. device slept past the stale window): open a fresh session.
          resume.current = { time: video.currentTime, playing: !video.paused };
          restart();
        } else if (code === 403 || code === 404) {
          setFatal('This video is no longer available to you.');
        } else if (code === 429) {
          setFatal('Too many requests. Please wait a moment and reload.');
        } else if (networkRetries++ < 5) {
          setTimeout(() => hls.startLoad(), 1000 * networkRetries);
        } else {
          setFatal('Network error — check your connection and reload.');
        }
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        setFatal('Playback failed.');
      }
    });

    hls.attachMedia(video);
    hls.loadSource(pb.manifestUrl);
    return () => {
      resume.current = { time: video.currentTime, playing: !video.paused };
      hls.destroy();
      hlsRef.current = null;
    };
  }, [pb.status, pb.manifestUrl, pb.generation, getToken, restart]);

  // ------------------------------------------------------------------ media element state
  useEffect(() => {
    const v = videoRef.current;
    const updateBuffered = () =>
      setBuffered(Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]));
    const handlers = {
      play: () => {
        setPlaying(true);
        setStarted(true);
      },
      pause: () => setPlaying(false),
      timeupdate: () => setTime(v.currentTime),
      durationchange: () => setDuration(v.duration),
      progress: updateBuffered,
      waiting: () => setBuffering(true),
      seeking: () => setBuffering(true),
      canplay: () => setBuffering(false),
      playing: () => setBuffering(false),
      seeked: () => {
        setBuffering(false);
        updateBuffered();
      },
      volumechange: () => {
        setVolume(v.volume);
        setMuted(v.muted);
      },
      ratechange: () => setSpeed(v.playbackRate),
    };
    Object.entries(handlers).forEach(([e, h]) => v.addEventListener(e, h));
    return () => Object.entries(handlers).forEach(([e, h]) => v.removeEventListener(e, h));
  }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Auto-hide controls while playing.
  const idleTimer = useRef();
  const poke = useCallback(() => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), 2800);
  }, []);
  useEffect(() => () => clearTimeout(idleTimer.current), []);

  const showFlash = (icon) => setFlash({ icon, key: Date.now() });

  // ------------------------------------------------------------------ actions
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (v.paused) {
      v.play().catch(() => {});
      showFlash(Play);
    } else {
      v.pause();
      showFlash(Pause);
    }
  }, []);
  const seekTo = useCallback((t) => {
    const v = videoRef.current;
    v.currentTime = Math.max(0, Math.min(t, v.duration || 0));
    setTime(v.currentTime);
  }, []);
  const skip = useCallback(
    (d) => {
      seekTo(videoRef.current.currentTime + d);
      showFlash(d > 0 ? RotateCw : RotateCcw);
    },
    [seekTo],
  );
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen();
    else containerRef.current.requestFullscreen?.();
  }, []);
  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 0.5;
  }, []);
  const setVol = (val) => {
    const v = videoRef.current;
    v.volume = val;
    v.muted = val === 0;
  };

  function selectQuality(value) {
    const index = Number(value);
    const hls = hlsRef.current;
    if (!hls) return;
    // -1 = ABR (bandwidth-driven auto switching); otherwise lock to a rendition immediately.
    hls.currentLevel = index;
    setAutoQuality(index === -1);
  }

  function onKey(e) {
    if (e.target.closest('[role=menu]')) return;
    const v = videoRef.current;
    const keys = {
      ' ': togglePlay, k: togglePlay, f: toggleFullscreen, m: toggleMute,
      ArrowLeft: () => skip(-5), ArrowRight: () => skip(5), j: () => skip(-SKIP), l: () => skip(SKIP),
      ArrowUp: () => setVol(Math.min(1, v.volume + 0.1)), ArrowDown: () => setVol(Math.max(0, v.volume - 0.1)),
    };
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
      poke();
    }
  }

  // ------------------------------------------------------------------ derived
  const heightOf = (i) => levels.find((l) => l.index === i)?.height;
  const activeHeight = heightOf(currentLevel);
  const qualityLabel = autoQuality ? `Auto${activeHeight ? ` · ${activeHeight}p` : ''}` : activeHeight ? `${activeHeight}p` : '—';
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const showChrome = !playing || !idle || menuOpen;
  const blocked = fatal || pb.status === 'error' || pb.status === 'limit';
  const loading = !blocked && (pb.status === 'starting' || (buffering && started));

  const setRefs = useCallback((el) => {
    containerRef.current = el;
    setContainer(el);
  }, []);

  return (
    <div
      ref={setRefs}
      data-fs={fullscreen}
      className={cn(
        'group/player relative aspect-video w-full select-none overflow-hidden rounded-2xl bg-black shadow-2xl shadow-black/50 ring-1 ring-white/10 outline-none',
        'data-[fs=true]:aspect-auto data-[fs=true]:rounded-none data-[fs=true]:ring-0',
        !showChrome && 'cursor-none',
      )}
      tabIndex={0}
      onKeyDown={onKey}
      onMouseMove={poke}
      onMouseLeave={() => playing && setIdle(true)}
      onContextMenu={(e) => e.preventDefault()} // UX nicety only — not a security control
    >
      <video
        ref={videoRef}
        className="size-full object-contain"
        playsInline
        controlsList="nodownload noremoteplayback noplaybackrate"
        disablePictureInPicture
        disableRemotePlayback
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
      />

      {pb.watermark && <Watermark text={pb.watermark} />}

      {/* Top bar: title + live quality */}
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-4 bg-gradient-to-b from-black/70 via-black/25 to-transparent px-5 pt-4 pb-12 transition-opacity duration-300',
          showChrome && started ? 'opacity-100' : 'opacity-0',
        )}
      >
        <h2 className="truncate text-sm font-medium text-white/90 drop-shadow">{title}</h2>
        {activeHeight && (
          <Badge variant="outline" className="shrink-0 border-white/20 bg-black/30 font-mono text-[10px] text-white/80 backdrop-blur">
            {activeHeight >= 720 ? 'HD ' : ''}
            {activeHeight}p
          </Badge>
        )}
      </div>

      {/* Center: start button / spinner / action flash */}
      <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
        {loading && <Loader2 className="size-12 animate-spin text-white/80 drop-shadow-lg" strokeWidth={1.5} />}
        {!loading && !blocked && pb.status === 'ready' && !playing && (
          <button
            onClick={togglePlay}
            aria-label="Play"
            className="pointer-events-auto grid size-20 place-items-center rounded-full bg-white/10 text-white ring-1 ring-white/25 backdrop-blur-md transition hover:scale-105 hover:bg-white/20 active:scale-95"
          >
            <Play className="ml-1 size-8 fill-current" />
          </button>
        )}
        {flash && playing && !loading && (
          <div
            key={flash.key}
            className="grid size-16 place-items-center rounded-full bg-black/40 text-white backdrop-blur-sm animate-out fade-out-0 zoom-out-110 duration-700 fill-mode-forwards"
          >
            <flash.icon className="size-7 fill-current" />
          </div>
        )}
      </div>

      {/* Blocking overlays */}
      {(fatal || pb.status === 'error') && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/80 p-6 backdrop-blur-sm">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <div className="grid size-12 place-items-center rounded-full bg-destructive/15 text-destructive">
              <ShieldAlert className="size-6" />
            </div>
            <p className="text-sm text-white/90">{fatal || pb.error}</p>
            <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>Reload</Button>
          </div>
        </div>
      )}
      {pb.status === 'limit' && (
        <div className="absolute inset-0 z-30 grid place-items-center overflow-y-auto bg-black/85 p-6 backdrop-blur-sm">
          <div className="w-full max-w-md space-y-4">
            <div className="flex items-center gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-full bg-white/10">
                <MonitorSmartphone className="size-5 text-white" />
              </div>
              <div>
                <p className="font-medium text-white">Streaming limit reached</p>
                <p className="text-sm text-white/60">{pb.error}</p>
              </div>
            </div>
            <ul className="divide-y divide-white/10 overflow-hidden rounded-xl border border-white/10 bg-white/5">
              {pb.sessions.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-white">{s.videoTitle}</p>
                    <p className="truncate text-xs text-white/50">
                      Since {new Date(s.startedAt).toLocaleTimeString()} · {s.userAgent}
                    </p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => pb.stopOtherSession(s.id)}>
                    Watch here
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Bottom controls */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-3 pt-16 pb-2 transition-opacity duration-300 sm:px-4',
          showChrome && !blocked ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <SeekBar time={time} duration={duration} buffered={buffered} onSeek={seekTo} />

        <div className="mt-1 flex items-center gap-0.5 sm:gap-1">
          <ControlButton label={playing ? 'Pause (k)' : 'Play (k)'} onClick={togglePlay} container={container}>
            {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </ControlButton>
          <ControlButton label={`Back ${SKIP}s (j)`} onClick={() => skip(-SKIP)} container={container} className="hidden sm:inline-flex">
            <RotateCcw />
          </ControlButton>
          <ControlButton label={`Forward ${SKIP}s (l)`} onClick={() => skip(SKIP)} container={container} className="hidden sm:inline-flex">
            <RotateCw />
          </ControlButton>

          <div className="group/vol flex items-center">
            <ControlButton label={muted ? 'Unmute (m)' : 'Mute (m)'} onClick={toggleMute} container={container}>
              <VolumeIcon />
            </ControlButton>
            <div className="w-0 overflow-hidden transition-all duration-300 group-hover/vol:w-24 group-focus-within/vol:w-24">
              <Slider
                aria-label="Volume"
                min={0}
                max={1}
                step={0.01}
                value={[muted ? 0 : volume]}
                onValueChange={([v]) => setVol(v)}
                className="mx-2 w-20 py-2 [&_[data-slot=slider-range]]:bg-white [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-thumb]]:border-0 [&_[data-slot=slider-track]]:h-1 [&_[data-slot=slider-track]]:bg-white/25"
              />
            </div>
          </div>

          <span className="ml-2 font-mono text-xs tabular-nums text-white/85">
            {fmtTime(time)} <span className="text-white/40">/ {fmtTime(duration)}</span>
          </span>

          <span className="flex-1" />

          <DropdownMenu modal={false} onOpenChange={setMenuOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Settings"
                    disabled={!levels.length}
                    className="size-9 rounded-full text-white hover:bg-white/15 hover:text-white [&_svg]:size-5"
                  >
                    <Settings className={cn('transition-transform duration-300', menuOpen && 'rotate-90')} />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent container={container} side="top" sideOffset={8} className="border border-white/10 bg-black/85 text-white">
                Settings
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              container={container}
              collisionBoundary={container}
              collisionPadding={8}
              side="top"
              align="end"
              sideOffset={10}
              className="w-60 rounded-xl border-white/10 bg-zinc-950/90 p-1.5 text-white backdrop-blur-xl"
            >
              <DropdownMenuLabel className="text-xs font-normal text-white/50">Playback</DropdownMenuLabel>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2 rounded-lg py-2 focus:bg-white/10 data-[state=open]:bg-white/10">
                  <SlidersHorizontal className="size-4 text-white/70" />
                  Quality
                  <span className="ml-auto text-xs text-white/60">{qualityLabel}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent container={container} collisionBoundary={container} collisionPadding={8} sideOffset={6} className="min-w-44 rounded-xl border-white/10 bg-zinc-950/90 p-1.5 text-white backdrop-blur-xl">
                  <DropdownMenuRadioGroup value={String(autoQuality ? -1 : currentLevel)} onValueChange={selectQuality}>
                    <QualityItem value="-1" label="Auto" hint={bandwidth ? `${(bandwidth / 1e6).toFixed(1)} Mbps` : 'Adaptive'} />
                    {[...levels]
                      .sort((a, b) => b.height - a.height)
                      .map((l) => (
                        <QualityItem
                          key={l.index}
                          value={String(l.index)}
                          label={`${l.height}p`}
                          hint={l.height >= 720 ? 'HD' : `${Math.round(l.bitrate / 1000)} kbps`}
                        />
                      ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2 rounded-lg py-2 focus:bg-white/10 data-[state=open]:bg-white/10">
                  <Gauge className="size-4 text-white/70" />
                  Speed
                  <span className="ml-auto text-xs text-white/60">{speed === 1 ? 'Normal' : `${speed}×`}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent container={container} collisionBoundary={container} collisionPadding={8} sideOffset={6} className="min-w-36 rounded-xl border-white/10 bg-zinc-950/90 p-1.5 text-white backdrop-blur-xl">
                  <DropdownMenuRadioGroup value={String(speed)} onValueChange={(v) => (videoRef.current.playbackRate = Number(v))}>
                    {SPEEDS.map((s) => (
                      <QualityItem key={s} value={String(s)} label={s === 1 ? 'Normal' : `${s}×`} />
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator className="bg-white/10" />
              <p className="px-2 py-1.5 text-[11px] leading-snug text-white/40">
                Shortcuts: space play · ←/→ 5s · j/l 10s · m mute · f fullscreen
              </p>
            </DropdownMenuContent>
          </DropdownMenu>

          <ControlButton label={fullscreen ? 'Exit fullscreen (f)' : 'Fullscreen (f)'} onClick={toggleFullscreen} container={container}>
            {fullscreen ? <Minimize /> : <Maximize />}
          </ControlButton>
        </div>
      </div>
    </div>
  );
}

// Radio item with a trailing check instead of shadcn's leading dot — reads cleaner in a player menu.
function QualityItem({ value, label, hint }) {
  return (
    <DropdownMenuRadioItem
      value={value}
      className="group/item rounded-lg py-2 pr-2 pl-8 focus:bg-white/10 [&>span:first-child]:hidden"
    >
      <Check className="absolute left-2 size-4 text-brand opacity-0 group-data-[state=checked]/item:opacity-100" />
      <span className="group-data-[state=checked]/item:font-medium">{label}</span>
      {hint && <span className="ml-auto text-xs text-white/45">{hint}</span>}
    </DropdownMenuRadioItem>
  );
}
