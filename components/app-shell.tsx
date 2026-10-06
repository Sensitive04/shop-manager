'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

import { api } from '@/components/api-client';

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/inventory', label: 'Inventory' },
  { href: '/pos', label: 'POS' },
  { href: '/ledger', label: 'Ledger' },
  { href: '/customers', label: 'Customers' },
] as const;

/**
 * App shell.
 *
 * A client component because the active-link highlight depends on the current
 * pathname. The nav is small enough that client-side rendering costs nothing and
 * avoids threading router state through a server layout.
 *
 * `user` is resolved on the server by the `(app)` layout and passed in, so the
 * name shown here cannot be spoofed by client state.
 */
export function AppShell({
  user,
  children,
}: {
  user: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  /**
   * Sign out, then leave immediately.
   *
   * The redirect runs even if the revoke request fails: the server is the only
   * place the session can be invalidated, but a visitor who asked to leave should
   * not be stranded on a page they are no longer authorised to see. A failed
   * revoke leaves a cookie that is useless without its (now unverified) token —
   * and the subsequent `replace('/login')` re-runs the server guard either way.
   */
  async function signOut() {
    setSigningOut(true);
    try {
      await api.delete<{ signedOut: boolean }>('/api/auth');
    } catch {
      // Intentionally ignored; see above.
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <div className="min-h-screen lg:flex">
      {/* Mobile bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-ink-200 bg-white px-4 py-3 lg:hidden">
        <span className="font-semibold text-ink-900">Skincare Manager</span>
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-controls="primary-nav"
          className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm font-medium"
        >
          {menuOpen ? 'Close' : 'Menu'}
        </button>
      </header>

      <nav
        id="primary-nav"
        aria-label="Primary"
        className={`${
          menuOpen ? 'block' : 'hidden'
        } flex flex-col border-b border-ink-200 bg-white px-3 py-3 lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r lg:px-3 lg:py-5`}
      >
        <div className="hidden lg:mb-6 lg:block lg:px-3">
          <p className="font-semibold text-ink-900">Skincare Manager</p>
          <p className="text-xs text-ink-500">Inventory &amp; POS</p>
        </div>

        <ul className="space-y-0.5">
          {NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={() => setMenuOpen(false)}
                aria-current={isActive(item.href) ? 'page' : undefined}
                className={`block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive(item.href)
                    ? 'bg-blush-100 text-blush-800'
                    : 'text-ink-700 hover:bg-ink-100'
                }`}
>
              {item.label}
            </Link>
          </li>
          ))}
        </ul>

        {/*
          Sign-out. Rendered in both layouts rather than desktop-only: on mobile
          the nav collapses behind the Menu button, so a hidden control would make
          signing out unreachable except by signing in again.
        */}
        <div className="mt-auto border-t border-ink-200 px-3 pb-3 pt-4">
          <p className="truncate text-sm font-medium text-ink-800" title={user}>
            {user}
          </p>
          <button
            type="button"
            onClick={() => void signOut()}
            disabled={signingOut}
            className="mt-1 text-xs font-medium text-ink-500 hover:text-critical disabled:opacity-60"
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </nav>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
    </div>
  );
}