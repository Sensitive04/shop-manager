'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

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
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

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
        } border-b border-ink-200 bg-white px-3 py-3 lg:sticky lg:top-0 lg:block lg:h-screen lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r lg:px-3 lg:py-5`}
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
      </nav>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
    </div>
  );
}