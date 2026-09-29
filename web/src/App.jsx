import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { LogOut, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from './lib/auth.jsx';
import { Login } from './pages/Login.jsx';
import { Library } from './pages/Library.jsx';
import { Watch } from './pages/Watch.jsx';
import { Upload } from './pages/Upload.jsx';
import { Courses } from './pages/Courses.jsx';

function Protected({ children, roles }) {
  const { user } = useAuth();
  if (user === undefined) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function NavItem({ to, children }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        cn('rounded-md px-3 py-1.5 text-sm transition-colors hover:text-foreground', isActive ? 'bg-secondary text-foreground' : 'text-muted-foreground')
      }
    >
      {children}
    </NavLink>
  );
}

export function App() {
  const { user, logout } = useAuth();
  const staff = user && ['instructor', 'admin'].includes(user.role);
  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-40 border-b bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Play className="ml-0.5 size-3.5 fill-current" />
            </span>
            Stream
          </Link>
          {user && (
            <>
              <nav className="flex items-center gap-1">
                <NavItem to="/">Library</NavItem>
                {staff && <NavItem to="/upload">Upload</NavItem>}
                {staff && <NavItem to="/courses">Courses</NavItem>}
              </nav>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="ml-auto h-9 gap-2 rounded-full px-1.5 pr-3">
                    <Avatar className="size-7">
                      <AvatarFallback className="bg-secondary text-xs">{user.name?.[0]?.toUpperCase() ?? '?'}</AvatarFallback>
                    </Avatar>
                    <span className="hidden text-sm sm:inline">{user.name}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="font-normal">
                    <p className="text-sm font-medium">{user.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                    <Badge variant="secondary" className="mt-2 capitalize">{user.role}</Badge>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={logout}>
                    <LogOut /> Log out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Routes>
          <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
          <Route path="/" element={<Protected><Library /></Protected>} />
          <Route path="/watch/:id" element={<Protected><Watch /></Protected>} />
          <Route path="/upload" element={<Protected roles={['instructor', 'admin']}><Upload /></Protected>} />
          <Route path="/courses" element={<Protected roles={['instructor', 'admin']}><Courses /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
