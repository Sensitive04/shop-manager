import 'server-only';

import { Types } from 'mongoose';

import { connectToDatabase } from '@/lib/db';
import { ValidationError } from '@/lib/errors';
import { startOfDay } from '@/lib/dates';
import { roundMoney } from '@/lib/money';
import { FinancialTransaction } from '@/models/FinancialTransaction';

import type { CreateTransactionInput } from '@/lib/validators';
import type { TransactionSummaryDto } from '@/types/dto';

/**
 * Financial ledger service.
 *
 * POS income arrives here already written by `checkout`; this service covers the
 * hand-entered side (rent, utilities, packaging) plus the reporting queries the
 * dashboard and ledger screens need.
 */

/** Record a manually entered income or expense. */
export async function recordTransaction(input: CreateTransactionInput) {
  await connectToDatabase();

  // Defensive re-check: the Mongoose schema validator also enforces this, but
  // failing here yields a 422 with a useful message instead of a driver error.
  const incomeOnly = input.type === 'income';
  if (incomeOnly && input.category !== 'Sales') {
    throw new ValidationError('Sales is the only income category.', [
      { path: 'category', message: 'Choose "Sales" for income, or switch to an outcome.' },
    ]);
  }
  if (!incomeOnly && input.category === 'Sales') {
    throw new ValidationError('Sales can only be recorded as income.', [
      { path: 'category', message: 'Choose an outcome type, or file this under income as "Sales".' },
    ]);
  }

  const created = await FinancialTransaction.create({
    type: input.type,
    amount: input.amount,
    category: input.category,
    paymentMethod: input.paymentMethod,
    ...(input.referenceNote ? { referenceNote: input.referenceNote } : {}),
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  });

  return created;
}

export interface SummaryFilter {
  from?: Date;
  to?: Date;
}

/**
 * Income, outcome and net totals for a period, plus per-category and
 * per-payment-method breakdowns.
 *
 * Amounts are summed in the aggregation pipeline and rounded once at the end,
 * rather than summed in JS across every document.
 */
export async function summarize(filter: SummaryFilter): Promise<TransactionSummaryDto> {
  await connectToDatabase();

  const match = buildDateMatch(filter);

  const [totals] = await FinancialTransaction.aggregate<{
    income: number;
    outcome: number;
    count: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: null,
        income: {
          $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] },
        },
        outcome: {
          $sum: { $cond: [{ $eq: ['$type', 'outcome'] }, '$amount', 0] },
        },
        count: { $sum: 1 },
      },
    },
  ]);

  const byCategoryRows = await FinancialTransaction.aggregate<{
    _id: { category: string; type: string };
    total: number;
    count: number;
  }>([
    { $match: match },
    { $group: { _id: { category: '$category', type: '$type' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);

  const byPaymentRows = await FinancialTransaction.aggregate<{
    _id: string;
    total: number;
  }>([
    { $match: match },
    { $group: { _id: '$paymentMethod', total: { $sum: '$amount' } } },
    { $sort: { total: -1 } },
  ]);

  const income = roundMoney(totals?.income ?? 0);
  const outcome = roundMoney(totals?.outcome ?? 0);

  return {
    income,
    outcome,
    net: roundMoney(income - outcome),
    count: totals?.count ?? 0,
    byCategory: byCategoryRows.map((row) => ({
      category: row._id.category,
      type: row._id.type,
      total: roundMoney(row.total),
      count: row.count,
    })),
    byPaymentMethod: byPaymentRows.map((row) => ({
      paymentMethod: row._id,
      total: roundMoney(row.total),
    })),
  };
}

/** Convert an optional date range into a Mongo match fragment. */
function buildDateMatch(filter: SummaryFilter): Record<string, unknown> {
  if (!filter.from && !filter.to) return {};

  const range: Record<string, Date> = {};
  // `from` is widened to the start of its day so "today" includes everything
  // already recorded today rather than only the current instant onward. `to` has
  // already been widened to the end of its day by the route's validator.
  if (filter.from) range.$gte = startOfDay(filter.from);
  if (filter.to) range.$lte = filter.to;

  return { occurredAt: range };
}

/** Totals for an explicit list of ObjectIds, used by the dashboard. */
export async function summarizeSalesByCustomer(
  customerId: Types.ObjectId,
): Promise<{ totalSpent: number; orderCount: number; lastPurchaseAt: Date | null }> {
  await connectToDatabase();

  const [row] = await FinancialTransaction.aggregate<{
    totalSpent: number;
    orderCount: number;
    lastPurchaseAt: Date | null;
  }>([
    { $match: { sale: { $ne: null }, occurredAt: { $exists: true } } },
    // Sales rows carry the sale reference; join back for the customer filter.
    { $lookup: { from: 'sales', localField: 'sale', foreignField: '_id', as: 'saleDoc' } },
    { $unwind: '$saleDoc' },
    { $match: { 'saleDoc.customer': customerId, type: 'income' } },
    {
      $group: {
        _id: null,
        totalSpent: { $sum: '$amount' },
        orderCount: { $sum: 1 },
        lastPurchaseAt: { $max: '$occurredAt' },
      },
    },
  ]);

  return {
    totalSpent: roundMoney(row?.totalSpent ?? 0),
    orderCount: row?.orderCount ?? 0,
    lastPurchaseAt: row?.lastPurchaseAt ?? null,
  };
}