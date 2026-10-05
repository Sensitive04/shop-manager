import { handleRoute, ok, readJson } from '@/lib/api';
import { startOfDay } from '@/lib/dates';
import { recordTransaction, summarize } from '@/lib/services/ledger';
import { createTransactionSchema, transactionQuerySchema } from '@/lib/validators';
import { connectToDatabase } from '@/lib/db';
import { toTransactionDto } from '@/lib/serializers';
import { FinancialTransaction } from '@/models/FinancialTransaction';
import type { QueryFilter } from 'mongoose';
import type { LeanFinancialTransaction, TransactionDto } from '@/types/dto';

/**
 * GET  /api/transactions — the ledger, filterable by type, category, payment
 *       method and date range.
 * POST /api/transactions — record a manual income or expense.
 *
 * POS income is written by /api/sales and appears here automatically; this
 * endpoint is for operating costs such as rent and utilities.
 */
export const GET = handleRoute(async (request: Request) => {
  await connectToDatabase();

  const url = new URL(request.url);
  const query = transactionQuerySchema.parse(Object.fromEntries(url.searchParams));

  const filter: QueryFilter<unknown> = {};

  if (query.type) filter.type = query.type;
  if (query.category) filter.category = query.category;
  if (query.paymentMethod) filter.paymentMethod = query.paymentMethod;

  if (query.from || query.to) {
    // `to` arrives already widened to the end of its day by the validator; see
    // dateInputEndOfDay for why that has to happen during parsing.
    const range: Record<string, Date> = {};
    if (query.from) range.$gte = startOfDay(query.from);
    if (query.to) range.$lte = query.to;
    filter.occurredAt = range;
  }

  const page = query.page ?? 1;
  const limit = query.limit ?? 25;
  const skip = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    FinancialTransaction.find(filter)
      .sort({ occurredAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<LeanFinancialTransaction[]>(),
    FinancialTransaction.countDocuments(filter),
  ]);

  const items: TransactionDto[] = rows.map(toTransactionDto);

  return ok({
    items,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    // Totals for the current filter, so the header reflects what is on screen.
    summary: await summarize({
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
    }),
  });
});

export const POST = handleRoute(async (request: Request) => {
  const input = createTransactionSchema.parse(await readJson(request));
  const created = await recordTransaction(input);
  return ok(toTransactionDto(created.toObject()), { status: 201 });
});