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
import { toDateInputValue } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import {
  INCOME_CATEGORIES,
  OUTCOME_CATEGORIES,
  PAYMENT_METHODS,
  TRANSACTION_TYPES,
} from '@/types/constants';
import type { TransactionDto, TransactionSummaryDto } from '@/types/dto';

type TypeFilter = 'all' | 'income' | 'outcome';

interface TransactionListResponse {
  items: TransactionDto[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Financial ledger.
 *
 * POS sales appear here automatically as `Sales` income. Shoppers can only add
 * `Miscellaneous` income; everything else must be an outcome, which keeps
 * operating costs out of the sales figure.
 */
export default function LedgerPage() {
  const [type, setType] = useState<TypeFilter>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [creating, setCreating] = useState(false);

  const window_ = useCallback(() => {
    const params = new URLSearchParams();
    // Sent as plain YYYY-MM-DD on purpose: the server widens them to local day
    // boundaries, which it cannot do once a UTC timestamp has been substituted
    // for the calendar date the shopkeeper actually picked.
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params;
  }, [from, to]);

  const summary = useAsync<TransactionSummaryDto>(
    async () => api.get(`/api/transactions/summary?${window_().toString()}`),
    [from, to],
  );

  const transactions = useAsync<TransactionListResponse>(
    async () => {
      const params = window_();
      if (type !== 'all') params.set('type', type);
      params.set('limit', '100');
      return api.get<TransactionListResponse>(`/api/transactions?${params.toString()}`);
    },
    [type, from, to],
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Ledger</h1>
          <p className="text-sm text-ink-500">
            Every sale and expense, newest first.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>Add entry</Button>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <Input
          label="From"
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <Input
          label="To"
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
      </div>

      {summary.loading ? (
        <PageSkeleton />
      ) : summary.error ? (
        <ErrorState message={summary.error} onRetry={summary.reload} />
      ) : summary.data ? (
        <>
          <section
            aria-label="Period totals"
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            <StatCard
              label="Income"
              value={formatMoney(summary.data.income)}
              tone="positive"
            />
            <StatCard
              label="Outcome"
              value={formatMoney(summary.data.outcome)}
              tone="warning"
            />
            <StatCard
              label="Net"
              value={formatMoney(summary.data.net)}
              tone={summary.data.net >= 0 ? 'positive' : 'critical'}
            />
            <StatCard label="Entries" value={summary.data.count} />
          </section>

          {summary.data.byCategory.length > 0 && (
            <Card title="By category" padded={false}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                    <tr>
                      <th scope="col" className="px-5 py-2.5 font-medium">Category</th>
                      <th scope="col" className="px-5 py-2.5 font-medium">Type</th>
                      <th scope="col" className="px-5 py-2.5 text-right font-medium">Entries</th>
                      <th scope="col" className="px-5 py-2.5 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-200">
                    {summary.data.byCategory.map((row) => (
                      <tr key={`${row.type}-${row.category}`}>
                        <td className="px-5 py-2.5 font-medium text-ink-900">{row.category}</td>
                        <td className="px-5 py-2.5">
                          <Badge tone={row.type === 'income' ? 'positive' : 'warning'}>
                            {row.type}
                          </Badge>
                        </td>
                        <td className="px-5 py-2.5 text-right tabular-nums text-ink-500">
                          {row.count}
                        </td>
                        <td className="px-5 py-2.5 text-right tabular-nums">
                          {formatMoney(row.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      ) : null}

      <Tabs<TypeFilter>
        active={type}
        onChange={setType}
        tabs={[
          { id: 'all', label: 'All' },
          { id: 'income', label: 'Income' },
          { id: 'outcome', label: 'Outcome' },
        ]}
      />

      <Card padded={false}>
        {transactions.loading ? (
          <PageSkeleton />
        ) : transactions.error ? (
          <ErrorState message={transactions.error} onRetry={transactions.reload} />
        ) : transactions.data && transactions.data.items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">Date</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Category</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Type</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Payment</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Note</th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200">
                {transactions.data.items.map((transaction) => (
                  <tr key={transaction.id}>
                    <td className="whitespace-nowrap px-5 py-2.5 text-ink-500">
                      {new Date(transaction.occurredAt).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-2.5 font-medium text-ink-900">
                      {transaction.category}
                    </td>
                    <td className="px-5 py-2.5">
                      <Badge tone={transaction.type === 'income' ? 'positive' : 'warning'}>
                        {transaction.type}
                      </Badge>
                    </td>
                    <td className="px-5 py-2.5 text-ink-500">
                      {transaction.paymentMethod}
                    </td>
                    <td className="px-5 py-2.5 text-ink-500">
                      {transaction.referenceNote ?? '—'}
                    </td>
                    <td
                      className={`px-5 py-2.5 text-right font-semibold tabular-nums ${
                        transaction.signedAmount >= 0 ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {transaction.signedAmount >= 0 ? '+' : ''}
                      {formatMoney(transaction.signedAmount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No entries in this period"
            description="Adjust the date range or record an expense."
          />
        )}
      </Card>

      {creating && (
        <TransactionDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void summary.reload();
            void transactions.reload();
          }}
        />
      )}
    </div>
  );
}

function TransactionDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<(typeof TRANSACTION_TYPES)[number]>('outcome');
  const [form, setForm] = useState<{
    amount: string;
    category: string;
    paymentMethod: string;
    referenceNote: string;
    occurredAt: string;
  }>({
    amount: '',
    category: OUTCOME_CATEGORIES[0],
    paymentMethod: PAYMENT_METHODS[0],
    referenceNote: '',
    occurredAt: toDateInputValue(new Date()),
  });

  // Keep the category valid as the type flips.
  const categoryOptions = type === 'income' ? INCOME_CATEGORIES : OUTCOME_CATEGORIES;
  const effectiveCategory = (categoryOptions as readonly string[]).includes(form.category)
    ? form.category
    : categoryOptions[0];

  const { submit, pending, error, fieldErrors } = useSubmit(async () => {
    await api.post('/api/transactions', {
      type,
      amount: Number(form.amount),
      category: effectiveCategory,
      paymentMethod: form.paymentMethod,
      ...(form.referenceNote.trim() ? { referenceNote: form.referenceNote.trim() } : {}),
      ...(form.occurredAt
        ? { occurredAt: new Date(`${form.occurredAt}T12:00:00`).toISOString() }
        : {}),
    });
    onSaved();
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/40 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Add ledger entry"
    >
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-ink-200 px-5 py-4">
          <h2 className="font-semibold text-ink-900">Add ledger entry</h2>
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

          <Select
            label="Type"
            value={type}
            onChange={(event) =>
              setType(event.target.value as (typeof TRANSACTION_TYPES)[number])
            }
            error={fieldErrors.type}
          >
            {TRANSACTION_TYPES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>

          <Input
            label="Amount"
            name="amount"
            type="number"
            min="0.01"
            step="0.01"
            required
            value={form.amount}
            onChange={(event) => setForm((p) => ({ ...p, amount: event.target.value }))}
            error={fieldErrors.amount}
          />

          <Select
            label="Category"
            value={effectiveCategory}
            onChange={(event) => setForm((p) => ({ ...p, category: event.target.value }))}
            error={fieldErrors.category}
            hint={
              type === 'income'
                ? 'Sales are recorded automatically by the POS.'
                : undefined
            }
          >
            {categoryOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>

          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="Payment method"
              value={form.paymentMethod}
              onChange={(event) =>
                setForm((p) => ({ ...p, paymentMethod: event.target.value }))
              }
              error={fieldErrors.paymentMethod}
            >
              {PAYMENT_METHODS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
            <Input
              label="Date"
              name="occurredAt"
              type="date"
              value={form.occurredAt}
              onChange={(event) => setForm((p) => ({ ...p, occurredAt: event.target.value }))}
              error={fieldErrors.occurredAt}
            />
          </div>

          <Textarea
            label="Note"
            name="referenceNote"
            rows={3}
            value={form.referenceNote}
            onChange={(event) =>
              setForm((p) => ({ ...p, referenceNote: event.target.value }))
            }
            error={fieldErrors.referenceNote}
            placeholder="Supplier invoice, receipt number…"
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save entry
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}