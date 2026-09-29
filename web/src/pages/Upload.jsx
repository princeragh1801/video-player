import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileVideo, Loader2, UploadCloud, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '../lib/api.js';
import { uploadVideo } from '../lib/multipartUpload.js';

const fmtBytes = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);

export function Upload() {
  const [courses, setCourses] = useState([]);
  const [form, setForm] = useState({ title: '', description: '', courseId: '', access: 'course' });
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(null);
  const abort = useRef(null);
  const inputRef = useRef(null);
  const navigate = useNavigate();
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  // Radix Select's hidden native <select> can emit '' when its options arrive after the value; ignore it.
  const setSelect = (k) => (v) => v && set(k)(v);

  useEffect(() => {
    api('/api/courses').then(({ courses }) => {
      const mine = courses.filter((c) => c.canManage);
      setCourses(mine);
      if (mine[0]) setForm((f) => ({ ...f, courseId: f.courseId || mine[0].id }));
    });
  }, []);

  function pick(f) {
    if (!f) return;
    if (!f.type.startsWith('video/')) return toast.error('Please choose a video file');
    setFile(f);
    if (!form.title) setForm((prev) => ({ ...prev, title: f.name.replace(/\.[^.]+$/, '') }));
  }

  async function submit(e) {
    e.preventDefault();
    if (!file) return toast.error('Choose a video to upload');
    if (form.access === 'course' && !form.courseId) return toast.error('Pick a course');
    setProgress(0);
    abort.current = new AbortController();
    try {
      await uploadVideo(
        file,
        { title: form.title, description: form.description, access: form.access, courseId: form.access === 'course' ? form.courseId : null },
        { onProgress: setProgress, signal: abort.current.signal },
      );
      toast.success('Upload complete — transcoding has started');
      navigate('/');
    } catch (err) {
      toast.error(err.name === 'AbortError' ? 'Upload cancelled' : err.message);
      setProgress(null);
    }
  }

  const uploading = progress !== null;
  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Upload video</CardTitle>
          <CardDescription>
            Files go straight to private storage in parallel chunks, then get transcoded into adaptive HLS (240p–1080p).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div
            role="button"
            tabIndex={0}
            onClick={() => !uploading && inputRef.current.click()}
            onKeyDown={(e) => e.key === 'Enter' && inputRef.current.click()}
            onDragOver={(e) => (e.preventDefault(), setDragging(true))}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pick(e.dataTransfer.files[0]);
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-8 text-center transition-colors',
              dragging ? 'border-brand bg-brand/5' : 'hover:border-ring hover:bg-secondary/40',
              uploading && 'pointer-events-none',
            )}
          >
            <input ref={inputRef} type="file" accept="video/*" className="hidden" onChange={(e) => pick(e.target.files[0])} />
            {file ? (
              <div className="flex w-full items-center gap-3 text-left">
                <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary">
                  <FileVideo className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{fmtBytes(file.size)}</p>
                </div>
                {!uploading && (
                  <Button type="button" variant="ghost" size="icon" onClick={(e) => (e.stopPropagation(), setFile(null))}>
                    <X />
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="grid size-11 place-items-center rounded-full bg-secondary">
                  <UploadCloud className="size-5" />
                </div>
                <p className="text-sm font-medium">Drop a video here or click to browse</p>
                <p className="text-xs text-muted-foreground">MP4, MOV, WebM, MKV</p>
              </>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input id="title" value={form.title} onChange={set('title')} required maxLength={200} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="desc">Description</Label>
            <Textarea id="desc" value={form.description} onChange={set('description')} rows={3} placeholder="Optional" />
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Who can watch</Label>
              <Select value={form.access} onValueChange={setSelect('access')}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="course">Enrolled students</SelectItem>
                  <SelectItem value="subscription">Active subscribers</SelectItem>
                  <SelectItem value="private">Only me</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.access === 'course' && (
              <div className="space-y-2">
                <Label>Course</Label>
                <Select value={form.courseId} onValueChange={setSelect('courseId')}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Create a course first" /></SelectTrigger>
                  <SelectContent>
                    {courses.map((c) => <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {uploading && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Uploading…</span>
                <span className="font-mono">{Math.round(progress * 100)}%</span>
              </div>
              <Progress value={progress * 100} className="h-1.5" />
            </div>
          )}
        </CardContent>
        <CardFooter className="justify-end gap-2">
          {uploading && (
            <Button type="button" variant="ghost" onClick={() => abort.current.abort()}>Cancel</Button>
          )}
          <Button disabled={uploading}>
            {uploading ? <Loader2 className="animate-spin" /> : <UploadCloud />}
            Upload
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
