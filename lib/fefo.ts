/**
 * FEFO (First Expiry, First Out) batch allocation.
 *
 * Skincare stock ages. Selling the batch closest to its expiry date first means
 * the expiring stock is what leaves the shelf, and it makes the "expiring soon"
 * inventory tab actionable rather than merely informative.
 *
 * This module is deliberately pure: it takes plain objects and returns plain
 * objects, so it can be exhaustively unit-tested without a database.
 */

export interface AllocatableBatch {
  id: string;
  expiryDate: Date;
  quantity: number;
}

export interface BatchAllocation {
  batchId: string;
  /** Units taken from this batch. Always a positive integer. */
  quantity: number;
}

export interface FefoResult {
  allocations: BatchAllocation[];
  /** Units that could not be covered because stock ran short. */
  shortfall: number;
  /** Units actually allocated. */
  allocated: number;
}

/**
 * Allocate `requested` units across `batches`, taking from the earliest
 * expiry first. Batches with a non-positive quantity are ignored.
 *
 * Allocation never exceeds `requested` and never oversells a batch. When there
 * is not enough stock the result carries a `shortfall` so the caller can reject
 * the whole sale rather than silently selling a partial quantity.
 */
export function allocateFefo(
  batches: readonly AllocatableBatch[],
  requested: number,
): FefoResult {
  const allocations: BatchAllocation[] = [];

  // Floor once, up front, and track everything against the floored figure. Using
  // the raw request here made `allocated` report 2.9 for a request of 2.9 even
  // though only 2 whole units could ever be allocated.
  const wanted = Math.floor(requested);

  if (!Number.isFinite(wanted) || wanted <= 0) {
    return { allocations, shortfall: 0, allocated: 0 };
  }

  let remaining = wanted;

  // Ties on expiryDate are broken by insertion order so allocation is
  // deterministic; otherwise a re-save could shuffle which batch is hit first.
  const ordered = batches
    .map((batch, index) => ({ batch, index }))
    .filter(({ batch }) => batch.quantity > 0)
    .sort((a, b) => {
      const delta = a.batch.expiryDate.getTime() - b.batch.expiryDate.getTime();
      return delta !== 0 ? delta : a.index - b.index;
    });

  for (const { batch } of ordered) {
    if (remaining <= 0) break;
    const take = Math.min(batch.quantity, remaining);
    allocations.push({ batchId: batch.id, quantity: take });
    remaining -= take;
  }

  return { allocations, shortfall: remaining, allocated: wanted - remaining };
}

/**
 * Batch expiring soonest first, ignoring empty batches. Used for display.
 */
export function sortBatchesByExpiry<T extends AllocatableBatch>(
  batches: readonly T[],
): T[] {
  return [...batches].sort(
    (a, b) => a.expiryDate.getTime() - b.expiryDate.getTime(),
  );
}

/** The soonest expiry among batches that still hold stock, or null if none. */
export function nearestExpiry(
  batches: readonly AllocatableBatch[],
): Date | null {
  const usable = sortBatchesByExpiry(batches.filter((b) => b.quantity > 0));
  return usable[0]?.expiryDate ?? null;
}