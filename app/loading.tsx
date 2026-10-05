import { PageSkeleton } from '@/components/ui';

/**
 * Route-level loading UI.
 *
 * Each page also guards its own fetch state, so this only covers the brief moment
 * before the client component mounts.
 */
export default function Loading() {
  return (
    <div className="min-h-screen bg-ink-50 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-6xl">
        <PageSkeleton />
      </div>
    </div>
  );
}