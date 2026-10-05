'use client';

import { useCallback, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { api, useAsync, useSubmit } from '@/components/api-client';
import { ExpiryBadge, StockBadge } from '@/components/inventory-shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  ErrorState,
  Input,
  PageSkeleton,
  Select,
  Tabs,
} from '@/components/ui';
import { formatMoney } from '@/lib/money';
import { toDateInputValue } from '@/lib/dates';
import { PRODUCT_CATEGORIES } from '@/types/constants';
import type { ProductDto, StockMovementDto } from '@/types/dto';

type TabId = 'all' | 'low-stock' | 'expiring' | 'movements';

interface ProductListResponse {
  items: ProductDto[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Inventory screen.
 *
 * Four tabs over one page: the catalogue, the low-stock queue, the expiry queue
 * and the movement audit log. The active tab is mirrored into `?tab=` so the
 * dashboard can deep-link into a specific queue.
 */
export default function InventoryPage() {
  const searchParams = useSearchParams();
  const initialTab = (searchParams.get('tab') as TabId | null) ?? 'all';
  const [tab, setTab] = useState<TabId>(
    ['all', 'low-stock', 'expiring', 'movements'].includes(initialTab)
      ? initialTab
      : 'all',
  );

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [editing, setEditing] = useState<ProductDto | null>(null);
  const [creating, setCreating] = useState(false);

  const loadProducts = useCallback(async (): Promise<ProductListResponse> => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (category) params.set('category', category);
    params.set('limit', '100');

    if (tab === 'low-stock') params.set('lowStock', 'true');
    if (tab === 'expiring') params.set('expiringWithinDays', '30');

    return api.get<ProductListResponse>(`/api/products?${params.toString()}`);
  }, [search, category, tab]);

  const products = useAsync<ProductListResponse>(loadProducts, [tab, search, category]);

  // Derived, not stored: the movement log is only worth fetching while its tab is
  // open, but keeping that in state would mean an effect writing to state on every
  // tab change.
  const showMovements = tab === 'movements';

  const movements = useAsync<{ items: StockMovementDto[] }>(
    async () => (showMovements ? api.get('/api/stock-movements?limit=50') : { items: [] }),
    [showMovements],
  );

  const lowStockCount = useAsync<ProductDto[]>(
    () => (tab === 'all' ? api.get('/api/products/low-stock') : Promise.resolve([])),
    [tab],
  );

  const expiringCount = useAsync<{ items: ProductDto[] }>(
    () =>
      tab === 'all'
        ? api.get<{ items: ProductDto[] }>('/api/products/expiring?days=30')
        : Promise.resolve({ items: [] }),
    [tab],
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Inventory</h1>
          <p className="text-sm text-ink-500">
            Stock levels, batch expiry and movement history.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>Add product</Button>
      </header>

      <Tabs<TabId>
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'all', label: 'All products' },
          { id: 'low-stock', label: 'Low stock', count: lowStockCount.data?.length },
          { id: 'expiring', label: 'Expiring soon', count: expiringCount.data?.items.length },
          { id: 'movements', label: 'Stock movements' },
        ]}
      />

      {tab !== 'movements' && (
        <div className="flex flex-wrap gap-3">
          <Input
            label="Search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name, SKU or brand"
            className="sm:w-72"
          />
          <Select
            label="Category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="sm:w-52"
          >
            <option value="">All categories</option>
            {PRODUCT_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </div>
      )}

      {tab === 'movements' ? (
        <MovementLog movements={movements} />
      ) : products.loading ? (
        <PageSkeleton />
      ) : products.error ? (
        <ErrorState message={products.error} onRetry={products.reload} />
      ) : (
        <ProductTable
          products={products.data?.items ?? []}
          onEdit={setEditing}
          onChanged={() => {
            void products.reload();
            void lowStockCount.reload();
            void expiringCount.reload();
          }}
        />
      )}

      {creating && (
        <ProductDialog
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void products.reload();
            void lowStockCount.reload();
            void expiringCount.reload();
          }}
        />
      )}

      {editing && (
        <ProductDialog
          mode="edit"
          product={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void products.reload();
            void lowStockCount.reload();
            void expiringCount.reload();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ table */

function ProductTable({
  products,
  onEdit,
  onChanged,
}: {
  products: ProductDto[];
  onEdit: (product: ProductDto) => void;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<ProductDto | null>(null);

  if (products.length === 0) {
    return (
      <Card padded={false}>
        <EmptyState
          title="No products found"
          description="Try a different search, or add your first product to get started."
        />
      </Card>
    );
  }

  return (
    <>
      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th scope="col" className="px-5 py-2.5 font-medium">Product</th>
                <th scope="col" className="px-5 py-2.5 font-medium">Category</th>
                <th scope="col" className="px-5 py-2.5 text-right font-medium">Price</th>
                <th scope="col" className="px-5 py-2.5 text-right font-medium">Stock</th>
                <th scope="col" className="px-5 py-2.5 font-medium">Expiry</th>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-200">
              {products.map((product) => (
                <tr key={product.id} className="hover:bg-ink-50">
                  <td className="px-5 py-3">
                    <p className="font-medium text-ink-900">{product.name}</p>
                    <p className="text-xs text-ink-500">
                      {product.sku}
                      {product.brand ? ` · ${product.brand}` : ''}
                    </p>
                  </td>
                  <td className="px-5 py-3">
                    <Badge>{product.category}</Badge>
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    {formatMoney(product.sellingPrice)}
                  </td>
                  <td className="px-5 py-3">
                    <StockBadge product={product} />
                  </td>
                  <td className="px-5 py-3">
                    <ExpiryBadge product={product} />
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="secondary" onClick={() => onEdit(product)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelected(product)}
                      >
                        Stock
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {selected && (
        <StockMovementDialog
          product={selected}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------------- movements */

function MovementLog({
  movements,
}: {
  movements: ReturnType<typeof useAsync<{ items: StockMovementDto[] }>>;
}) {
  if (movements.loading) return <PageSkeleton />;
  if (movements.error) {
    return <ErrorState message={movements.error} onRetry={movements.reload} />;
  }

  const items = movements.data?.items ?? [];

  if (items.length === 0) {
    return (
      <Card padded={false}>
        <EmptyState
          title="No stock movements yet"
          description="Every stock-in and stock-out will be recorded here."
        />
      </Card>
    );
  }

  return (
    <Card padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th scope="col" className="px-5 py-2.5 font-medium">When</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Product</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Type</th>
              <th scope="col" className="px-5 py-2.5 text-right font-medium">Change</th>
              <th scope="col" className="px-5 py-2.5 text-right font-medium">Stock</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-200">
            {items.map((movement) => (
              <tr key={movement.id}>
                <td className="whitespace-nowrap px-5 py-2.5 text-ink-500">
                  {new Date(movement.occurredAt).toLocaleString()}
                </td>
                <td className="px-5 py-2.5">
                  <p className="font-medium text-ink-900">{movement.productName}</p>
                  {movement.batchNumber && (
                    <p className="text-xs text-ink-500">Batch {movement.batchNumber}</p>
                  )}
                </td>
                <td className="px-5 py-2.5">
                  <Badge
                    tone={
                      movement.type === 'stock-in'
                        ? 'positive'
                        : movement.type === 'stock-out'
                          ? 'accent'
                          : 'warning'
                    }
                  >
                    {movement.type}
                  </Badge>
                </td>
                <td
                  className={`px-5 py-2.5 text-right font-medium tabular-nums ${
                    movement.quantity > 0 ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {movement.quantity > 0 ? '+' : ''}
                  {movement.quantity}
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-ink-500">
                  {movement.stockBefore} → {movement.stockAfter}
                </td>
                <td className="px-5 py-2.5 text-ink-500">{movement.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ dialog */

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/40 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-ink-200 px-5 py-4">
          <h2 className="font-semibold text-ink-900">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </header>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function ProductDialog({
  mode,
  product,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  product?: ProductDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: product?.name ?? '',
    sku: product?.sku ?? '',
    category: product?.category ?? PRODUCT_CATEGORIES[0],
    brand: product?.brand ?? '',
    size: product?.size ?? '',
    sellingPrice: product?.sellingPrice?.toString() ?? '',
    minStockAlert: product?.minStockAlert?.toString() ?? '5',
    notes: product?.notes ?? '',
  });

  const [openingStock, setOpeningStock] = useState({
    batchNumber: '',
    expiryDate: '',
    costPrice: '',
    quantity: '',
  });

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const { submit, pending, error, fieldErrors } = useSubmit(async () => {
    if (mode === 'create') {
      // Only attach an opening batch when the user actually filled it in.
      const hasOpeningStock =
        openingStock.batchNumber.trim() &&
        openingStock.expiryDate &&
        openingStock.costPrice &&
        openingStock.quantity;

      await api.post('/api/products', {
        ...form,
        batches: hasOpeningStock
          ? [
              {
                batchNumber: openingStock.batchNumber.trim(),
                expiryDate: openingStock.expiryDate,
                costPrice: Number(openingStock.costPrice),
                quantity: Number(openingStock.quantity),
              },
            ]
          : [],
      });
    } else {
      await api.patch(`/api/products/${product?.id}`, form);
    }
    onSaved();
  });

  return (
    <Dialog title={mode === 'create' ? 'Add product' : 'Edit product'} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error && <ErrorBanner message={error} />}

        <Input
          label="Name"
          name="name"
          required
          value={form.name}
          onChange={(event) => set('name')(event.target.value)}
          error={fieldErrors.name}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="SKU"
            name="sku"
            required
            value={form.sku}
            onChange={(event) => set('sku')(event.target.value.toUpperCase())}
            error={fieldErrors.sku}
            hint="Letters, numbers, . - _"
          />
          <Select
            label="Category"
            value={form.category}
            onChange={(event) => set('category')(event.target.value)}
            error={fieldErrors.category}
          >
            {PRODUCT_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Input
            label="Selling price"
            name="sellingPrice"
            type="number"
            min="0"
            step="0.01"
            required
            value={form.sellingPrice}
            onChange={(event) => set('sellingPrice')(event.target.value)}
            error={fieldErrors.sellingPrice}
          />
          <Input
            label="Alert at"
            name="minStockAlert"
            type="number"
            min="0"
            step="1"
            required
            value={form.minStockAlert}
            onChange={(event) => set('minStockAlert')(event.target.value)}
            error={fieldErrors.minStockAlert}
            hint="Reorder point"
          />
          <Input
            label="Brand"
            name="brand"
            value={form.brand}
            onChange={(event) => set('brand')(event.target.value)}
            error={fieldErrors.brand}
          />
        </div>

        {mode === 'create' && (
          <fieldset className="rounded-lg border border-ink-200 p-4">
            <legend className="px-1 text-sm font-medium text-ink-700">
              Opening stock (optional)
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Batch number"
                name="batchNumber"
                value={openingStock.batchNumber}
                onChange={(event) =>
                  setOpeningStock((p) => ({ ...p, batchNumber: event.target.value }))
                }
              />
              <Input
                label="Expiry date"
                name="expiryDate"
                type="date"
                min={toDateInputValue(new Date())}
                value={openingStock.expiryDate}
                onChange={(event) =>
                  setOpeningStock((p) => ({ ...p, expiryDate: event.target.value }))
                }
              />
              <Input
                label="Cost price"
                name="costPrice"
                type="number"
                min="0"
                step="0.01"
                value={openingStock.costPrice}
                onChange={(event) =>
                  setOpeningStock((p) => ({ ...p, costPrice: event.target.value }))
                }
              />
              <Input
                label="Quantity"
                name="quantity"
                type="number"
                min="1"
                step="1"
                value={openingStock.quantity}
                onChange={(event) =>
                  setOpeningStock((p) => ({ ...p, quantity: event.target.value }))
                }
              />
            </div>
          </fieldset>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            {mode === 'create' ? 'Add product' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function StockMovementDialog({
  product,
  onClose,
  onSaved,
}: {
  product: ProductDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<'in' | 'out'>('in');
  const [form, setForm] = useState({
    batchNumber: '',
    expiryDate: '',
    costPrice: '',
    supplier: '',
    quantity: '',
    reason: '',
  });

  const { submit, pending, error, fieldErrors } = useSubmit(async () => {
    if (tab === 'in') {
      await api.post(`/api/products/${product.id}/batches`, {
        batchNumber: form.batchNumber,
        expiryDate: form.expiryDate,
        costPrice: Number(form.costPrice),
        quantity: Number(form.quantity),
        ...(form.supplier ? { supplier: form.supplier } : {}),
      });
    } else {
      await api.post(`/api/products/${product.id}/stock-out`, {
        quantity: Number(form.quantity),
        ...(form.reason ? { reason: form.reason } : {}),
      });
    }
    onSaved();
  });

  return (
    <Dialog title={`Stock · ${product.name}`} onClose={onClose}>
      <div className="space-y-4">
        <Tabs<'in' | 'out'>
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'in', label: 'Stock in' },
            { id: 'out', label: 'Stock out' },
          ]}
        />

        {product.batches.length > 0 && (
          <div className="rounded-lg border border-ink-200">
            <p className="border-b border-ink-200 bg-ink-50 px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink-500">
              Current batches
            </p>
            <ul className="divide-y divide-ink-200 text-sm">
              {product.batches.map((batch) => (
                <li key={batch.id} className="flex items-center justify-between px-3 py-2">
                  <span>
                    <span className="font-medium text-ink-900">{batch.batchNumber}</span>
                    <span className="ml-2 text-xs text-ink-500">
                      exp {new Date(batch.expiryDate).toLocaleDateString()}
                    </span>
                  </span>
                  <span className="tabular-nums text-ink-700">
                    {batch.quantity} · {formatMoney(batch.costPrice)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error && <ErrorBanner message={error} />}

          {tab === 'in' ? (
            <>
              <Input
                label="Batch number"
                name="batchNumber"
                required
                value={form.batchNumber}
                onChange={(event) =>
                  setForm((p) => ({ ...p, batchNumber: event.target.value }))
                }
                error={fieldErrors.batchNumber}
              />
              <Input
                label="Expiry date"
                name="expiryDate"
                type="date"
                required
                value={form.expiryDate}
                onChange={(event) =>
                  setForm((p) => ({ ...p, expiryDate: event.target.value }))
                }
                error={fieldErrors.expiryDate}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="Cost price"
                  name="costPrice"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  value={form.costPrice}
                  onChange={(event) =>
                    setForm((p) => ({ ...p, costPrice: event.target.value }))
                  }
                  error={fieldErrors.costPrice}
                />
                <Input
                  label="Quantity"
                  name="quantity"
                  type="number"
                  min="1"
                  step="1"
                  required
                  value={form.quantity}
                  onChange={(event) =>
                    setForm((p) => ({ ...p, quantity: event.target.value }))
                  }
                  error={fieldErrors.quantity}
                />
              </div>
              <Input
                label="Supplier"
                name="supplier"
                value={form.supplier}
                onChange={(event) =>
                  setForm((p) => ({ ...p, supplier: event.target.value }))
                }
              />
            </>
          ) : (
            <>
              <Input
                label="Quantity"
                name="quantity"
                type="number"
                min="1"
                step="1"
                required
                value={form.quantity}
                onChange={(event) =>
                  setForm((p) => ({ ...p, quantity: event.target.value }))
                }
                error={fieldErrors.quantity}
                hint="Uses the soonest-expiring batch first"
              />
              <Input
                label="Reason"
                name="reason"
                value={form.reason}
                onChange={(event) =>
                  setForm((p) => ({ ...p, reason: event.target.value }))
                }
                placeholder="Damaged, sample, shrinkage…"
              />
            </>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              {tab === 'in' ? 'Receive stock' : 'Remove stock'}
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}