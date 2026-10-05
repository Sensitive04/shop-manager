'use client';

import { useMemo } from 'react';

import { api, useAsync } from '@/components/api-client';
import { ErrorState, PageSkeleton, StatCard, Card } from '@/components/ui';
import { formatMoney } from '@/lib/money';
import type { DashboardDto } from '@/types/dto';
import { ExpiryBadge, StockBadge } from '@/components/inventory-shared';
import Link from 'next/link';

/** Dashboard: today's takings, stock position and the two alert queues. */
export default function DashboardPage() {
  const { data, error, loading, reload } = useAsync<DashboardDto>(
    () => api.get('/api/dashboard'),
  );

  if (loading) return <PageSkeleton />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink-900">Dashboard</h1>
        <p className="text-sm text-ink-500">Today at a glance.</p>
      </header>

      <section
        aria-label="Today's totals"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <StatCard
          label="Sales today"
          value={formatMoney(data.today.sales)}
          hint={`${data.today.orders} order${data.today.orders === 1 ? '' : 's'}`}
          tone="positive"
        />
        <StatCard
          label="Expenses today"
          value={formatMoney(data.today.outcome)}
          tone="warning"
        />
        <StatCard
          label="Net today"
          value={formatMoney(data.today.net)}
          tone={data.today.net >= 0 ? 'positive' : 'critical'}
        />
        <StatCard
          label="Stock at cost"
          value={formatMoney(data.inventory.stockCostValue)}
          hint={`Retail ${formatMoney(data.inventory.retailValue)}`}
        />
      </section>

      <section
        aria-label="Stock alerts"
        className="grid gap-4 sm:grid-cols-3"
      >
        <StatCard
          label="Low or out of stock"
          value={data.inventory.lowStockCount}
          hint={`${data.inventory.outOfStockCount} out of stock`}
          tone={data.inventory.lowStockCount > 0 ? 'warning' : 'positive'}
        />
        <StatCard
          label="Expiring within 30 days"
          value={data.inventory.expiringSoonCount}
          tone={data.inventory.expiringSoonCount > 0 ? 'critical' : 'positive'}
        />
        <StatCard
          label="Active products"
          value={data.inventory.productCount}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Needs restocking"
          actions={
            <Link
              href={{ pathname: '/inventory', query: { tab: 'low-stock' } }}
              className="text-sm font-medium text-blush-700 hover:underline"
            >
              View all
            </Link>
          }
          padded={false}
        >
          {data.lowStockProducts.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-ink-500">
              Every product is above its reorder point.
            </p>
          ) : (
            <ul className="divide-y divide-ink-200">
              {data.lowStockProducts.map((product) => (
                <li
                  key={product.id}
                  className="flex items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink-900">{product.name}</p>
                    <p className="text-xs text-ink-500">{product.sku}</p>
                  </div>
                  <StockBadge product={product} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Expiring soon"
          actions={
            <Link
              href={{ pathname: '/inventory', query: { tab: 'expiring' } }}
              className="text-sm font-medium text-blush-700 hover:underline"
            >
              View all
            </Link>
          }
          padded={false}
        >
          {data.expiringProducts.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-ink-500">
              Nothing expires in the next 30 days.
            </p>
          ) : (
            <ul className="divide-y divide-ink-200">
              {data.expiringProducts.map((product) => (
                <li
                  key={product.id}
                  className="flex items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink-900">{product.name}</p>
                    <p className="text-xs text-ink-500">{product.sku}</p>
                  </div>
                  <ExpiryBadge product={product} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Best sellers (last 30 days)" padded={false}>
        {data.topProducts.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ink-500">
            No sales recorded yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">Product</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">SKU</th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium">Sold</th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200">
                {data.topProducts.map((product) => (
                  <tr key={product.productId}>
                    <td className="px-5 py-2.5 font-medium text-ink-900">{product.name}</td>
                    <td className="px-5 py-2.5 text-ink-500">{product.sku}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{product.quantitySold}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">
                      {formatMoney(product.revenue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <RecentSales sales={data.recentSales} />
    </div>
  );
}

function RecentSales({ sales }: { sales: DashboardDto['recentSales'] }) {
  const total = useMemo(
    () => sales.reduce((sum, sale) => sum + sale.total, 0),
    [sales],
  );

  return (
    <Card
      title="Recent sales"
      description={sales.length > 0 ? `${formatMoney(total)} across ${sales.length} order(s) today` : undefined}
      padded={false}
    >
      {sales.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-ink-500">No sales yet today.</p>
      ) : (
        <ul className="divide-y divide-ink-200">
          {sales.map((sale) => (
            <li key={sale.id} className="px-5 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-medium text-ink-900">
                  {sale.customer?.name ?? 'Walk-in customer'}
                </p>
                <p className="font-semibold tabular-nums text-ink-900">
                  {formatMoney(sale.total)}
                </p>
              </div>
              <p className="mt-0.5 text-xs text-ink-500">
                {sale.items.map((item) => `${item.quantity}× ${item.name}`).join(', ')}
              </p>
              <p className="mt-0.5 text-xs text-ink-400">
                {new Date(sale.createdAt).toLocaleTimeString()} · {sale.paymentMethod}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}