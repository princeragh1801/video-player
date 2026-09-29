import { useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAuth } from '../lib/auth.jsx';

export function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const isLogin = mode === 'login';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isLogin) await login(form.email, form.password);
      else await register(form.name, form.email, form.password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-[70svh] place-items-center">
      <Card className="w-full max-w-sm">
        <form onSubmit={submit}>
          <CardHeader className="mb-6 text-center">
            <div className="mx-auto mb-2 grid size-10 place-items-center rounded-full bg-secondary">
              <Lock className="size-4" />
            </div>
            <CardTitle className="text-xl">{isLogin ? 'Welcome back' : 'Create your account'}</CardTitle>
            <CardDescription>{isLogin ? 'Sign in to continue watching' : 'Start learning in seconds'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!isLogin && (
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={form.name} onChange={set('name')} required autoComplete="name" />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" placeholder="you@example.com" value={form.email} onChange={set('email')} required autoComplete="email" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={form.password}
                onChange={set('password')}
                required
                minLength={isLogin ? undefined : 10}
                autoComplete={isLogin ? 'current-password' : 'new-password'}
              />
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </CardContent>
          <CardFooter className="mt-6 flex-col gap-3">
            <Button className="w-full" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {isLogin ? 'Sign in' : 'Create account'}
            </Button>
            <Button type="button" variant="link" size="sm" className="text-muted-foreground" onClick={() => setMode(isLogin ? 'register' : 'login')}>
              {isLogin ? "Don't have an account? Register" : 'Already have an account? Sign in'}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
