import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Clapperboard, Loader2, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '../lib/api.js';

// Deterministic, tasteful gradient per video (there are no thumbnails in the MVP).
function hue(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function Thumb({ video }) {
  const h = hue(video.id);
  return (
    <div
      className="relative aspect-video overflow-hidden rounded-xl ring-1 ring-white/10"
      style={{ background: `radial-gradient(120% 90% at 20% 10%, oklch(0.45 0.12 ${h}), oklch(0.2 0.04 ${h + 40}) 60%, oklch(0.14 0.01 ${h + 80}))` }}
    >
      <div className="absolute inset-0 bg-[linear-gradient(to_top,rgb(0_0_0/0.55),transparent_50%)]" />
      {video.status === 'READY' ? (
        <>
          <div className="absolute inset-0 grid place-items-center">
            <div className="grid size-12 place-items-center rounded-full bg-white/15 text-white opacity-0 ring-1 ring-white/25 backdrop-blur-md transition-all duration-300 group-hover:scale-100 group-hover:opacity-100 scale-90">
              <Play className="ml-0.5 size-5 fill-current" />
            </div>
          </div>
          {video.durationSeconds != null && (
            <span className="absolute right-2 bottom-2 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-white">
              {fmtTime(video.durationSeconds)}
            </span>
          )}
          {video.qualities?.includes('1080p') || video.qualities?.includes('720p') ? (
            <span className="absolute top-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white">HD</span>
          ) : null}
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-white/80">
          {video.status === 'FAILED' ? <AlertTriangle className="size-6 text-destructive" /> : <Loader2 className="size-6 animate-spin" />}
          <span className="text-xs font-medium tracking-wider uppercase">{video.status === 'PROCESSING' ? 'Processing' : video.status}</span>
          {video.status === 'PROCESSING' && video.progress != null && (
            <Progress value={video.progress} className="h-1 w-full bg-white/15 [&>div]:bg-white" />
          )}
        </div>
      )}
    </div>
  );
}

function VideoCard({ video }) {
  const ready = video.status === 'READY';
  const body = (
    <>
      <Thumb video={video} />
      <div className="mt-3 space-y-1 px-0.5">
        <h3 className="line-clamp-1 font-medium">{video.title}</h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{video.courseTitle ?? (video.access === 'subscription' ? 'Subscribers' : 'Private')}</span>
          {video.qualities?.length > 0 && (
            <>
              <span>·</span>
              <span>{video.qualities.at(-1)}</span>
            </>
          )}
          {video.canManage && (
            <Badge variant="outline" className="ml-auto text-[10px]">Yours</Badge>
          )}
        </div>
        {video.status === 'FAILED' && video.error && <p className="line-clamp-2 text-xs text-destructive">{video.error}</p>}
      </div>
    </>
  );
  return ready ? (
    <Link to={`/watch/${video.id}`} className="group block rounded-2xl p-2 transition-colors hover:bg-card">
      {body}
    </Link>
  ) : (
    <div className={cn('rounded-2xl p-2', video.status !== 'FAILED' && 'opacity-90')}>{body}</div>
  );
}

export function Library() {
  const [videos, setVideos] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let timer;
    const load = () =>
      api('/api/videos')
        .then(({ videos }) => {
          setVideos(videos);
          // Poll while anything of ours is still processing.
          if (videos.some((v) => v.status === 'PROCESSING' || v.status === 'UPLOADING')) timer = setTimeout(load, 4000);
        })
        .catch((e) => setError(e.message));
    load();
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
        <p className="text-sm text-muted-foreground">Videos you have access to</p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!videos && !error && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="space-y-3 p-2">
              <Skeleton className="aspect-video rounded-xl" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          ))}
        </div>
      )}
      {videos?.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed py-20 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-secondary">
            <Clapperboard className="size-5 text-muted-foreground" />
          </div>
          <p className="font-medium">Nothing here yet</p>
          <p className="max-w-xs text-sm text-muted-foreground">Once you're enrolled in a course, its videos will show up here.</p>
        </div>
      )}
      {videos?.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {videos.map((v) => <VideoCard key={v.id} video={v} />)}
        </div>
      )}
    </div>
  );
}

