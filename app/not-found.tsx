import Link from 'next/link';

export const metadata = { title: 'Not found' };

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-ink-500">404</p>
        <h1 className="mt-2 text-2xl font-semibold text-ink-900">Page not found</h1>
        <p className="mt-2 text-sm text-ink-500">
          That page does not exist. It may have been moved.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex h-10 items-center rounded-lg bg-blush-600 px-4 text-sm font-medium text-white hover:bg-blush-700"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}