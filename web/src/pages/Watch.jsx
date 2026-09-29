import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Clock, GraduationCap, Layers, ShieldCheck } from 'lucide-react';
import { fmtTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '../lib/api.js';
import { VideoPlayer } from '../player/VideoPlayer.jsx';

export function Watch() {
  const { id } = useParams();
  const [video, setVideo] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api(`/api/videos/${id}`).then((r) => setVideo(r.video)).catch((e) => setError(e.message));
  }, [id]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
        <Link to="/"><ArrowLeft /> Library</Link>
      </Button>
      {video ? <VideoPlayer key={id} videoId={id} title={video.title} /> : <Skeleton className="aspect-video w-full rounded-2xl" />}
      {video && (
        <div className="space-y-4">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">{video.title}</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {video.courseTitle && (
                <Badge variant="secondary" className="gap-1"><GraduationCap className="size-3" />{video.courseTitle}</Badge>
              )}
              {video.durationSeconds != null && (
                <Badge variant="outline" className="gap-1"><Clock className="size-3" />{fmtTime(video.durationSeconds)}</Badge>
              )}
              {video.qualities?.length > 0 && (
                <Badge variant="outline" className="gap-1"><Layers className="size-3" />{video.qualities.join(' · ')}</Badge>
              )}
              <Badge variant="outline" className="gap-1"><ShieldCheck className="size-3" />Protected stream</Badge>
            </div>
          </div>
          {video.description && (
            <>
              <Separator />
              <p className="max-w-3xl text-sm leading-relaxed whitespace-pre-line text-muted-foreground">{video.description}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
