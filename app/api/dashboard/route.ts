import { handleRoute, ok } from '@/lib/api';
import { connectToDatabase } from '@/lib/db';
import { addDays, startOfDay } from '@/lib/dates';
import { roundMoney } from '@/lib/money';
import { toSaleDto } from '@/lib/serializers';
import { FinancialTransaction } from '@/models/FinancialTransaction';
import { Product } from '@/models/Product';
import { Sale } from '@/models/Sale';
import { expiringProducts, lowStockProducts } from '@/lib/services/products';
import type { DashboardDto, LeanSale } from '@/types/dto';

/**
 * GET /api/dashboard
 *
 * Everything the home screen needs in one request: today's takings, inventory
 * position, best sellers, recent sales, and the two alert lists. Batched so the
 * page costs a single round trip instead of eight.
 */
export const GET = handleRoute(async () => {
  await connectToDatabase();

  const now = new Date();
  const todayStart = startOfDay(now);

  const [
    todayTotals,
    productCount,
    lowStock,
    expiring,
    topProducts,
    recentSales,
    stockValues,
  ] = await Promise.all([
    FinancialTransaction.aggregate<{
      income: number;
      outcome: number;
    }>([
      { $match: { occurredAt: { $gte: todayStart } } },
      {
        $group: {
          _id: null,
          income: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
          outcome: { $sum: { $cond: [{ $eq: ['$type', 'outcome'] }, '$amount', 0] } },
        },
      },
    ]),

    Product.countDocuments({ active: true }),

    lowStockProducts(),
    expiringProducts(30),

    Sale.aggregate<{
      _id: unknown;
      name: string;
      sku: string;
      quantitySold: number;
      revenue: number;
    }>([
      { $match: { createdAt: { $gte: addDays(todayStart, -30) } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.product',
          name: { $first: '$items.name' },
          sku: { $first: '$items.sku' },
          quantitySold: { $sum: '$items.quantity' },
          revenue: { $sum: '$items.lineTotal' },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]),

    Sale.find({ createdAt: { $gte: todayStart } })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('customer', 'name phone skinType')
      .lean<LeanSale[]>(),

    Product.aggregate<{ costValue: number; retailValue: number }>([
      { $match: { active: true } },
      {
        $group: {
          _id: null,
          costValue: {
            $sum: {
              $sum: { $map: { input: '$batches', as: 'b', in: { $multiply: ['$$b.costPrice', '$$b.quantity'] } } },
            },
          },
          retailValue: { $sum: { $multiply: ['$stockQuantity', '$sellingPrice'] } },
        },
      },
    ]),
  ]);

  const ordersToday = await Sale.countDocuments({ createdAt: { $gte: todayStart } });

  const outOfStockCount = lowStock.filter(
    (product) => product.stockStatus === 'out-of-stock',
  ).length;

  const dashboard: DashboardDto = {
    today: {
      sales: roundMoney(todayTotals?.[0]?.income ?? 0),
      income: roundMoney(todayTotals?.[0]?.income ?? 0),
      outcome: roundMoney(todayTotals?.[0]?.outcome ?? 0),
      net: roundMoney(
        (todayTotals?.[0]?.income ?? 0) - (todayTotals?.[0]?.outcome ?? 0),
      ),
      orders: ordersToday,
    },
    inventory: {
      productCount,
      lowStockCount: lowStock.length,
      outOfStockCount,
      expiringSoonCount: expiring.length,
      stockCostValue: roundMoney(stockValues?.[0]?.costValue ?? 0),
      retailValue: roundMoney(stockValues?.[0]?.retailValue ?? 0),
    },
    topProducts: topProducts.map((row) => ({
      productId: String(row._id),
      name: row.name,
      sku: row.sku,
      quantitySold: row.quantitySold,
      revenue: roundMoney(row.revenue),
    })),
    recentSales: recentSales.map(toSaleDto),
    lowStockProducts: lowStock.slice(0, 8),
    expiringProducts: expiring.slice(0, 8),
  };

  return ok(dashboard);
});

