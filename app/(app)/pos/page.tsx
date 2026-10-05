'use client';

import { useCallback, useMemo, useState } from 'react';

import { api, useAsync, useSubmit } from '@/components/api-client';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Input,
  Select,
  StatCard,
} from '@/components/ui';
import { formatMoney, roundMoney } from '@/lib/money';
import { PAYMENT_METHODS } from '@/types/constants';
import type { CustomerDto, CheckoutResultDto, ProductDto } from '@/types/dto';

interface CartLine {
  product: ProductDto;
  quantity: number;
}

type DiscountType = 'none' | 'percent' | 'fixed';

/**
 * Point of sale.
 *
 * A single screen: search on the left, cart on the right. Totals are recomputed
 * client-side purely for display; the authoritative figures (and the discount
 * clamping) are computed server-side again inside the checkout transaction, so
 * the numbers shown and the numbers stored cannot diverge.
 */
export default function PosPage() {
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discountType, setDiscountType] = useState<DiscountType>('none');
  const [discountValue, setDiscountValue] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<string>(PAYMENT_METHODS[0]);
  const [customerId, setCustomerId] = useState('');
  const [cashier, setCashier] = useState('');
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState<CheckoutResultDto | null>(null);

  const products = useAsync<{ items: ProductDto[] }>(
    async () => {
      const params = new URLSearchParams({ limit: '60' });
      if (search.trim()) params.set('search', search.trim());
      const result = await api.get<{ items: ProductDto[] }>(
        `/api/products?${params.toString()}`,
      );
      return { items: result.items.filter((product) => product.stockQuantity > 0) };
    },
    [search],
  );

  const customers = useAsync<{ items: CustomerDto[] }>(
    () => api.get('/api/customers?limit=100'),
    [],
  );

  const addToCart = useCallback((product: ProductDto) => {
    setReceipt(null);
    setCart((previous) => {
      const existing = previous.find((line) => line.product.id === product.id);
      if (existing) {
        // Never let the cart request more than is on hand.
        if (existing.quantity >= product.stockQuantity) return previous;
        return previous.map((line) =>
          line.product.id === product.id
            ? { ...line, quantity: line.quantity + 1 }
            : line,
        );
      }
      return [...previous, { product, quantity: 1 }];
    });
  }, []);

  const setQuantity = useCallback((productId: string, quantity: number) => {
    setCart((previous) =>
      previous
        .map((line) =>
          line.product.id === productId
            ? {
                ...line,
                quantity: Math.max(0, Math.min(quantity, line.product.stockQuantity)),
              }
            : line,
        )
        .filter((line) => line.quantity > 0),
    );
  }, []);

  const totals = useMemo(() => {
    const subtotal = roundMoney(
      cart.reduce((sum, line) => sum + line.product.sellingPrice * line.quantity, 0),
    );
    const raw = Number(discountValue || 0);
    const discountAmount =
      discountType === 'none' || !Number.isFinite(raw) || raw <= 0
        ? 0
        : discountType === 'percent'
          ? roundMoney((subtotal * raw) / 100)
          : roundMoney(raw);
    const clamped = Math.max(0, Math.min(discountAmount, subtotal));
    const total = roundMoney(subtotal - clamped);
    return {
      subtotal,
      discountAmount: clamped,
      total,
      itemCount: cart.reduce((sum, line) => sum + line.quantity, 0),
    };
  }, [cart, discountType, discountValue]);

  const checkoutAction = useSubmit(async () => {
    const result = await api.post<CheckoutResultDto>('/api/sales', {
      items: cart.map((line) => ({
        productId: line.product.id,
        quantity: line.quantity,
      })),
      discountType,
      discountValue: Number(discountValue || 0),
      paymentMethod,
      ...(customerId ? { customerId } : {}),
      ...(cashier.trim() ? { cashier: cashier.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });

    // Only clear the ticket once the server has confirmed the sale.
    setCart([]);
    setDiscountType('none');
    setDiscountValue('');
    setNote('');
    setReceipt(result);
    await Promise.all([products.reload(), customers.reload()]);
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink-900">Point of sale</h1>
        <p className="text-sm text-ink-500">Search, add to the cart, then take payment.</p>
      </header>

      {receipt && (
        <Card
          title="Sale completed"
          description={receipt.atomic ? undefined : 'Recorded without a database transaction'}
          actions={
            <Button variant="ghost" size="sm" onClick={() => setReceipt(null)}>
              Dismiss
            </Button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Subtotal" value={formatMoney(receipt.subtotal)} />
            <StatCard label="Discount" value={`-${formatMoney(receipt.discountAmount)}`} />
            <StatCard label="Total taken" value={formatMoney(receipt.total)} tone="positive" />
            <StatCard
              label="Gross profit"
              value={formatMoney(receipt.grossProfit)}
              hint={`Cost ${formatMoney(receipt.totalCost)}`}
              tone={receipt.grossProfit >= 0 ? 'positive' : 'critical'}
            />
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Input
            label="Search products"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name, SKU or brand"
          />

          <Card className="mt-4" padded={false}>
            {products.error ? (
              <div className="p-5">
                <ErrorBanner message={products.error} />
              </div>
            ) : products.loading ? (
              <p className="px-5 py-10 text-center text-sm text-ink-500">Loading…</p>
            ) : products.data && products.data.items.length > 0 ? (
              <ul className="max-h-[28rem] divide-y divide-ink-200 overflow-y-auto">
                {products.data.items.map((product) => (
                  <li key={product.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink-900">{product.name}</p>
                      <p className="text-xs text-ink-500">
                        {product.sku} · {product.category}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-sm font-medium tabular-nums">
                        {formatMoney(product.sellingPrice)}
                      </span>
                      <Badge tone={product.stockStatus === 'ok' ? 'neutral' : 'warning'}>
                        {product.stockQuantity}
                      </Badge>
                      <Button size="sm" variant="secondary" onClick={() => addToCart(product)}>
                        Add
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="No in-stock products"
                description="Nothing matches that search, or the catalogue is empty."
              />
            )}
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Card title="Cart" description={`${totals.itemCount} item(s)`} padded={false}>
            {cart.length === 0 ? (
              <EmptyState
                title="Cart is empty"
                description="Add a product from the list to start a sale."
              />
            ) : (
              <ul className="divide-y divide-ink-200">
                {cart.map((line) => (
                  <li key={line.product.id} className="px-5 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-ink-900">{line.product.name}</p>
                      <p className="shrink-0 text-sm font-semibold tabular-nums">
                        {formatMoney(line.product.sellingPrice * line.quantity)}
                      </p>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setQuantity(line.product.id, line.quantity - 1)}
                        aria-label={`Remove one ${line.product.name}`}
                      >
                        −
                      </Button>
                      <Input
                        type="number"
                        min={1}
                        max={line.product.stockQuantity}
                        value={line.quantity}
                        onChange={(event) =>
                          setQuantity(line.product.id, Number(event.target.value))
                        }
                        className="w-20 text-center"
                        aria-label={`Quantity of ${line.product.name}`}
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setQuantity(line.product.id, line.quantity + 1)}
                        aria-label={`Add one ${line.product.name}`}
                      >
                        +
                      </Button>
                      <span className="text-xs text-ink-500">
                        {line.product.stockQuantity} available
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Payment" className="mt-4">
            <div className="space-y-4">
              {checkoutAction.error && <ErrorBanner message={checkoutAction.error} />}

              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  label="Discount"
                  value={discountType}
                  onChange={(event) => setDiscountType(event.target.value as DiscountType)}
                >
                  <option value="none">No discount</option>
                  <option value="percent">Percentage</option>
                  <option value="fixed">Fixed amount</option>
                </Select>
                <Input
                  label="Discount value"
                  type="number"
                  min="0"
                  step="0.01"
                  value={discountValue}
                  disabled={discountType === 'none'}
                  onChange={(event) => setDiscountValue(event.target.value)}
                  placeholder={discountType === 'percent' ? '10' : '5.00'}
                  hint={discountType === 'percent' ? 'Percent off' : undefined}
                />
              </div>

              <Select
                label="Payment method"
                value={paymentMethod}
                onChange={(event) => setPaymentMethod(event.target.value)}
                error={checkoutAction.fieldErrors.paymentMethod}
              >
                {PAYMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </Select>

              <Select
                label="Customer"
                value={customerId}
                onChange={(event) => setCustomerId(event.target.value)}
              >
                <option value="">Walk-in customer</option>
                {(customers.data?.items ?? []).map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                    {customer.phone ? ` · ${customer.phone}` : ''}
                  </option>
                ))}
              </Select>

              <Input
                label="Cashier"
                value={cashier}
                onChange={(event) => setCashier(event.target.value)}
                placeholder="Optional"
                error={checkoutAction.fieldErrors.cashier}
              />

              <Input
                label="Note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Optional"
              />

              <dl className="space-y-1 border-t border-ink-200 pt-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-ink-500">Subtotal</dt>
                  <dd className="tabular-nums text-ink-900">{formatMoney(totals.subtotal)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-500">Discount</dt>
                  <dd className="tabular-nums text-ink-900">
                    -{formatMoney(totals.discountAmount)}
                  </dd>
                </div>
                <div className="flex justify-between text-base font-semibold">
                  <dt>Total</dt>
                  <dd className="tabular-nums">{formatMoney(totals.total)}</dd>
                </div>
              </dl>

              <Button
                size="lg"
                className="w-full"
                loading={checkoutAction.pending}
                disabled={cart.length === 0}
                onClick={() => void checkoutAction.submit()}
              >
                Complete sale · {formatMoney(totals.total)}
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}