'use client';

import { useCallback, useState } from 'react';

import { api, useAsync, useSubmit } from '@/components/api-client';
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
  StatCard,
  Tabs,
  Textarea,
} from '@/components/ui';
import { formatMoney } from '@/lib/money';
import { SKIN_TYPES } from '@/types/constants';
import type { CustomerDto, ProductDto, SaleDto } from '@/types/dto';

interface CustomerListResponse {
  items: CustomerDto[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

type Panel = 'profile' | 'history' | 'recommendations';

/**
 * Customer book.
 *
 * Selecting a customer reveals their spend stats, purchase history and a
 * recommendation picker. Suggestions are advisory only — the shop assistant
 * decides what to tag, and nothing is auto-applied to a sale.
 */
export default function CustomersPage() {
  const [search, setSearch] = useState('');
  const [skinType, setSkinType] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<CustomerListResponse> => {
    const params = new URLSearchParams({ limit: '100' });
    if (search.trim()) params.set('search', search.trim());
    if (skinType) params.set('skinType', skinType);
    return api.get<CustomerListResponse>(`/api/customers?${params.toString()}`);
  }, [search, skinType]);

  const customers = useAsync<CustomerListResponse>(load, [search, skinType]);
  const selected = selectedId ?? customers.data?.items[0]?.id ?? null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Customers</h1>
          <p className="text-sm text-ink-500">Profiles, history and product suggestions.</p>
        </div>
        <Button onClick={() => setCreating(true)}>Add customer</Button>
      </header>

      <div className="flex flex-wrap gap-3">
        <Input
          label="Search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Name or phone"
          className="sm:w-72"
        />
        <Select
          label="Skin type"
          value={skinType}
          onChange={(event) => setSkinType(event.target.value)}
          className="sm:w-52"
        >
          <option value="">Any skin type</option>
          {SKIN_TYPES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      </div>

      {customers.loading ? (
        <PageSkeleton />
      ) : customers.error ? (
        <ErrorState message={customers.error} onRetry={customers.reload} />
      ) : customers.data && customers.data.items.length > 0 ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card title={`${customers.data.total} customer(s)`} padded={false}>
            <ul className="max-h-[32rem] divide-y divide-ink-200 overflow-y-auto">
              {customers.data.items.map((customer) => (
                <li key={customer.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(customer.id)}
                    aria-current={customer.id === selected ? 'true' : undefined}
                    className={`w-full px-5 py-3 text-left transition-colors ${
                      customer.id === selected ? 'bg-blush-50' : 'hover:bg-ink-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink-900">{customer.name}</span>
                      {customer.isWalkIn && <Badge>Walk-in</Badge>}
                    </div>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {customer.phone ?? 'No phone'} · {customer.skinType}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <div className="lg:col-span-2">
            {selected && <CustomerPanel customerId={selected} />}
          </div>
        </div>
      ) : (
        <Card padded={false}>
          <EmptyState
            title="No customers yet"
            description="Add a customer to track purchases and suggest products."
          />
        </Card>
      )}

      {creating && (
        <CustomerDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void customers.reload();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- panel */

function CustomerPanel({ customerId }: { customerId: string }) {
  const [panel, setPanel] = useState<Panel>('profile');

  const customer = useAsync<CustomerDto>(
    () => api.get(`/api/customers/${customerId}`),
    [customerId],
  );

  if (customer.loading) {
    return (
      <Card>
        <PageSkeleton />
      </Card>
    );
  }
  if (customer.error) {
    return <ErrorState message={customer.error} onRetry={customer.reload} />;
  }
  if (!customer.data) return null;

  const profile = customer.data;

  return (
    <div className="space-y-4">
      <Card
        title={profile.name}
        description={[profile.phone, profile.skinType].filter(Boolean).join(' · ')}
        actions={profile.isWalkIn ? <Badge>Walk-in</Badge> : undefined}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            label="Total spent"
            value={formatMoney(profile.stats?.totalSpent ?? 0)}
            tone="positive"
          />
          <StatCard label="Orders" value={profile.stats?.orderCount ?? 0} />
          <StatCard
            label="Last purchase"
            value={
              profile.stats?.lastPurchaseAt
                ? new Date(profile.stats.lastPurchaseAt).toLocaleDateString()
                : 'Never'
            }
          />
        </div>
      </Card>

      <Tabs<Panel>
        active={panel}
        onChange={setPanel}
        tabs={[
          { id: 'profile', label: 'Profile' },
          { id: 'history', label: 'History' },
          {
            id: 'recommendations',
            label: 'Recommendations',
            count: profile.recommendedProducts.length,
          },
        ]}
      />

      {panel === 'profile' && (
        <ProfileEditor customer={profile} onSaved={() => void customer.reload()} />
      )}

      {panel === 'history' && <CustomerHistory customerId={customerId} />}

      {panel === 'recommendations' && (
        <RecommendationPanel
          customerId={customerId}
          customer={profile}
          onChanged={() => void customer.reload()}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ profile */

function ProfileEditor({
  customer,
  onSaved,
}: {
  customer: CustomerDto;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: customer.name,
    phone: customer.phone ?? '',
    skinType: customer.skinType,
    notes: customer.notes ?? '',
    isWalkIn: customer.isWalkIn,
  });

  const { submit, pending, error, fieldErrors } = useSubmit(async () => {
    await api.patch(`/api/customers/${customer.id}`, {
      name: form.name,
      ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
      skinType: form.skinType,
      ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
      isWalkIn: form.isWalkIn,
    });
    onSaved();
  });

  return (
    <Card title="Profile" description="Update contact details and skin type.">
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
          onChange={(event) => setForm((p) => ({ ...p, name: event.target.value }))}
          error={fieldErrors.name}
        />

        <Input
          label="Phone"
          name="phone"
          type="tel"
          value={form.phone}
          onChange={(event) => setForm((p) => ({ ...p, phone: event.target.value }))}
          error={fieldErrors.phone}
          hint="Optional for walk-in customers"
        />

        <Select
          label="Skin type"
          value={form.skinType}
          onChange={(event) => setForm((p) => ({ ...p, skinType: event.target.value }))}
          error={fieldErrors.skinType}
        >
          {SKIN_TYPES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>

        <Textarea
          label="Notes"
          name="notes"
          rows={3}
          value={form.notes}
          onChange={(event) => setForm((p) => ({ ...p, notes: event.target.value }))}
          error={fieldErrors.notes}
          placeholder="Allergies, preferences…"
        />

        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={form.isWalkIn}
            onChange={(event) => setForm((p) => ({ ...p, isWalkIn: event.target.checked }))}
            className="h-4 w-4 rounded border-ink-300"
          />
          Walk-in customer (no contact details)
        </label>

        <div className="flex justify-end">
          <Button type="submit" loading={pending}>
            Save profile
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* ------------------------------------------------------------------ history */

function CustomerHistory({ customerId }: { customerId: string }) {
  const sales = useAsync<SaleDto[]>(
    () => api.get(`/api/customers/${customerId}/history?limit=50`),
    [customerId],
  );

  if (sales.loading) {
    return (
      <Card>
        <PageSkeleton />
      </Card>
    );
  }
  if (sales.error) {
    return <ErrorState message={sales.error} onRetry={sales.reload} />;
  }

  const items = sales.data ?? [];
  const total = items.reduce((sum, sale) => sum + sale.total, 0);

  if (items.length === 0) {
    return (
      <Card padded={false}>
        <EmptyState
          title="No purchases yet"
          description="Sales recorded at the POS will appear here."
        />
      </Card>
    );
  }

  return (
    <Card
      title="Purchase history"
      description={`${formatMoney(total)} across ${items.length} order(s)`}
      padded={false}
    >
      <ul className="divide-y divide-ink-200">
        {items.map((sale) => (
          <li key={sale.id} className="px-5 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-ink-900">
                {new Date(sale.createdAt).toLocaleDateString()}
              </span>
              <span className="font-semibold tabular-nums text-ink-900">
                {formatMoney(sale.total)}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-ink-500">
              {sale.items.map((item) => `${item.quantity}× ${item.name}`).join(', ')}
            </p>
            <p className="mt-0.5 text-xs text-ink-400">
              {sale.discountAmount > 0 ? `Discount -${formatMoney(sale.discountAmount)} · ` : ''}
              {sale.paymentMethod}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ----------------------------------------------------------- recommendations */

function RecommendationPanel({
  customerId,
  customer,
  onChanged,
}: {
  customerId: string;
  customer: CustomerDto;
  onChanged: () => void;
}) {
  const products = useAsync<{ items: ProductDto[] }>(
    () => api.get('/api/products?limit=200'),
    [],
  );

  // Edited locally until saved, so ticking a box is instant but the server stays
  // the source of truth for what is actually tagged.
  const [selected, setSelected] = useState<string[]>(
    () => customer.recommendedProducts.map((product) => product.id),
  );

  const save = useSubmit(async () => {
    await api.patch(`/api/customers/${customerId}`, {
      skinType: customer.skinType,
      recommendedProducts: selected,
    });
    onChanged();
  });

  const toggle = (productId: string) =>
    setSelected((previous) =>
      previous.includes(productId)
        ? previous.filter((id) => id !== productId)
        : [...previous, productId],
    );

  const suggested = (products.data?.items ?? []).filter(
    (product) =>
      customer.skinType === 'Dry'
        ? product.category === 'Moisturizer'
        : product.category === 'Serum',
  );

  return (
    <Card
      title="Recommended products"
      description={`${selected.length} tagged. Suggestions are advisory — nothing is applied to a sale automatically.`}
    >
      <div className="space-y-4">
        {save.error && <ErrorBanner message={save.error} />}

        {suggested.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">
              Suggested for {customer.skinType} skin
            </p>
            <div className="flex flex-wrap gap-2">
              {suggested.map((product) => (
                <Button
                  key={product.id}
                  size="sm"
                  variant={selected.includes(product.id) ? 'primary' : 'secondary'}
                  onClick={() => toggle(product.id)}
                >
                  {selected.includes(product.id) ? '✓ ' : '+ '}
                  {product.name}
                </Button>
              ))}
            </div>
          </div>
        )}

        {products.error ? (
          <ErrorState message={products.error} onRetry={products.reload} />
        ) : products.loading ? (
          <PageSkeleton />
        ) : (
          <ul className="max-h-80 divide-y divide-ink-200 overflow-y-auto rounded-lg border border-ink-200">
            {(products.data?.items ?? []).map((product) => (
              <li key={product.id} className="flex items-center justify-between gap-3 px-4 py-2">
                <label className="flex min-w-0 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selected.includes(product.id)}
                    onChange={() => toggle(product.id)}
                    className="h-4 w-4 rounded border-ink-300"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink-900">
                      {product.name}
                    </span>
                    <span className="block text-xs text-ink-500">
                      {product.category} · {formatMoney(product.sellingPrice)}
                    </span>
                  </span>
                </label>
                {product.stockStatus !== 'ok' && (
                  <Badge tone="warning">{product.stockQuantity} left</Badge>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end">
          <Button loading={save.pending} onClick={() => void save.submit()}>
            Save recommendations
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ dialog */

function CustomerDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<{
    name: string;
    phone: string;
    skinType: string;
    notes: string;
    isWalkIn: boolean;
  }>({
    name: '',
    phone: '',
    skinType: SKIN_TYPES[0],
    notes: '',
    isWalkIn: false,
  });

  const { submit, pending, error, fieldErrors } = useSubmit(async () => {
    await api.post('/api/customers', {
      name: form.name,
      ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
      skinType: form.skinType,
      ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
      isWalkIn: form.isWalkIn,
    });
    onSaved();
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/40 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Add customer"
    >
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-ink-200 px-5 py-4">
          <h2 className="font-semibold text-ink-900">Add customer</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </header>

        <form
          className="space-y-4 px-5 py-4"
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
            onChange={(event) => setForm((p) => ({ ...p, name: event.target.value }))}
            error={fieldErrors.name}
          />

          <Input
            label="Phone"
            name="phone"
            type="tel"
            value={form.phone}
            onChange={(event) => setForm((p) => ({ ...p, phone: event.target.value }))}
            error={fieldErrors.phone}
            hint="Optional for walk-in customers"
          />

          <Select
            label="Skin type"
            value={form.skinType}
            onChange={(event) => setForm((p) => ({ ...p, skinType: event.target.value }))}
            error={fieldErrors.skinType}
          >
            {SKIN_TYPES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>

          <Textarea
            label="Notes"
            name="notes"
            rows={3}
            value={form.notes}
            onChange={(event) => setForm((p) => ({ ...p, notes: event.target.value }))}
            error={fieldErrors.notes}
            placeholder="Allergies, preferences…"
          />

          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={form.isWalkIn}
              onChange={(event) => setForm((p) => ({ ...p, isWalkIn: event.target.checked }))}
              className="h-4 w-4 rounded border-ink-300"
            />
            Walk-in customer (no contact details)
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Add customer
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}