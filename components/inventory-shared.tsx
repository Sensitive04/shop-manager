'use client';

import { useMemo } from 'react';

import { formatMoney } from '@/lib/money';
import { daysUntil } from '@/lib/dates';
import type { ProductDto } from '@/types/dto';
import { Badge } from '@/components/ui';

/** Formatting helpers shared by the inventory and POS screens. */

export function useCurrency(code = 'USD') {
  return useMemo(() => {
    const format = (amount: number) => formatMoney(amount, code);
    return { format };
  }, [code]);
}

export function StockBadge({ product }: { product: ProductDto }) {
  if (product.stockStatus === 'out-of-stock') {
    return <Badge tone="critical">Out of stock</Badge>;
  }
  if (product.stockStatus === 'low-stock') {
    return (
      <Badge tone="warning">
        Low · {product.stockQuantity}/{product.minStockAlert}
      </Badge>
    );
  }
  return <Badge tone="positive">{product.stockQuantity} in stock</Badge>;
}

/**
 * Expiry badge. Anything already expired reads as critical, anything inside the
 * window as a warning, so the urgency is obvious without reading the date.
 */
export function ExpiryBadge({ product }: { product: ProductDto }) {
  if (!product.nearestExpiry) return <span className="text-ink-400">—</span>;

  const days = daysUntil(new Date(), new Date(product.nearestExpiry));

  if (days < 0) {
    return <Badge tone="critical">Expired {Math.abs(days)}d ago</Badge>;
  }
  if (days <= 7) return <Badge tone="critical">{days}d left</Badge>;
  if (days <= 30) return <Badge tone="warning">{days}d left</Badge>;
  return <Badge tone="neutral">{days}d left</Badge>;
}