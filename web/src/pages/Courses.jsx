import { useEffect, useState } from 'react';
import { GraduationCap, Plus, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '../lib/api.js';

function Enrollments({ course }) {
  const [list, setList] = useState([]);
  const [email, setEmail] = useState('');
  const load = () => api(`/api/courses/${course.id}/enrollments`).then((r) => setList(r.enrollments));
  useEffect(() => {
    load();
  }, [course.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function enroll(e) {
    e.preventDefault();
    try {
      await api(`/api/courses/${course.id}/enrollments`, { method: 'POST', body: { email } });
      toast.success(`Enrolled ${email}`);
      setEmail('');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function revoke(e) {
    await api(`/api/courses/${course.id}/enrollments/${e.user_id}`, { method: 'DELETE' });
    toast(`Access revoked for ${e.email}`, { description: 'Any active playback was stopped.' });
    load();
  }

  const active = list.filter((e) => e.status === 'active').length;
  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary">
          <GraduationCap className="size-5" />
        </div>
        <div className="space-y-1">
          <CardTitle>{course.title}</CardTitle>
          <CardDescription className="flex items-center gap-1"><Users className="size-3.5" />{active} enrolled</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="flex gap-2" onSubmit={enroll}>
          <Input type="email" placeholder="student@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <Button variant="secondary"><UserPlus /> Enroll</Button>
        </form>
        {list.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {list.map((e) => (
              <li key={e.user_id} className="flex items-center gap-3 px-3 py-2.5">
                <Avatar className="size-7"><AvatarFallback className="text-xs">{e.name?.[0]?.toUpperCase()}</AvatarFallback></Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{e.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{e.email}</p>
                </div>
                <Badge variant={e.status === 'active' ? 'secondary' : 'outline'} className="capitalize">{e.status}</Badge>
                {e.status === 'active' && (
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => revoke(e)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function Courses() {
  const [courses, setCourses] = useState([]);
  const [title, setTitle] = useState('');
  const load = () => api('/api/courses').then((r) => setCourses(r.courses.filter((c) => c.canManage)));
  useEffect(() => {
    load();
  }, []);

  async function create(e) {
    e.preventDefault();
    await api('/api/courses', { method: 'POST', body: { title } });
    toast.success('Course created');
    setTitle('');
    load();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Courses</h1>
          <p className="text-sm text-muted-foreground">Manage who can watch your videos</p>
        </div>
        <form className="flex w-full gap-2 sm:w-auto" onSubmit={create}>
          <Input placeholder="New course title" value={title} onChange={(e) => setTitle(e.target.value)} required className="sm:w-60" />
          <Button><Plus /> Create</Button>
        </form>
      </div>
      {courses.map((c) => <Enrollments key={c.id} course={c} />)}
    </div>
  );
}
