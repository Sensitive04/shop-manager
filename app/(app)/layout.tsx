import { AppShell } from '@/components/app-shell';

/**
 * Route group holding the authenticated app pages.
 *
 * Every page is a client component that fetches from `/api/*`, so the shell is
 * the only shared server-side piece and no page touches the database during
 * prerendering.
 */
export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <AppShell>{children}</AppShell>;
}