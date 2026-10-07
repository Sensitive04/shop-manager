/**
 * Demo data seeder.
 *
 * Run with `npm run seed`. It wipes the collections and rebuilds a small but
 * realistic shop: a catalogue of skincare products each holding several batches
 * at different expiry dates and costs, customers, a week of POS sales and the
 * operating expenses that go with them.
 *
 * Pass `--owner-only` to create just the sign-in account and touch no data —
 * useful on a fresh database (or after one was wiped) when the shop needs its
 * login restored without any sample stock:
 *
 *   npm run seed -- --owner-only
 *
 * The owner account is always created first, so a missing credential aborts
 * before anything is destroyed, and the account itself is deliberately not in
 * the deleteMany list: wiping demo data must never lock the shop out.
 *
 * Sales go through the real `checkout` service rather than being inserted
 * directly, so the seeded state is produced by exactly the code path the app
 * runs — FEFO allocation, the stock audit trail and the ledger link are all
 * genuine, not fabricated.
 *
 * Why `tsx` with `--conditions=react-server`: the services import `server-only`
 * as a guard against client bundling, whose default export throws outside a
 * React Server Component graph. The `react-server` condition resolves it to the
 * no-op build, which is what a server-side script needs.
 */

import { connectToDatabase, disconnectFromDatabase } from '@/lib/db';
import { ensureUser } from '@/lib/auth';
import { ownerCredentialsSchema } from '@/lib/validators';
import { checkout } from '@/lib/services/sales';
import { createProduct } from '@/lib/services/products';
import { createCustomer } from '@/lib/services/customers';
import { recordTransaction } from '@/lib/services/ledger';
import { Customer } from '@/models/Customer';
import { FinancialTransaction } from '@/models/FinancialTransaction';
import { Product } from '@/models/Product';
import { Sale } from '@/models/Sale';
import { StockMovement } from '@/models/StockMovement';
import { addDays } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import type { ProductShape } from '@/models/Product';

const SUPPLIER = 'GlowLab Distribution';

/** Deterministic pseudo-random so repeated seeds produce identical data. */
function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const random = makeRandom(20260101);

function pick<T>(values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  // The array is never empty at any call site; this satisfies noUncheckedIndexedAccess.
  return value as T;
}

const today = new Date();

/* ------------------------------------------------------------------ products */

interface SeedProduct {
  name: string;
  sku: string;
  category: (typeof import('@/types/constants').PRODUCT_CATEGORIES)[number];
  brand: string;
  size: string;
  sellingPrice: number;
  minStockAlert: number;
  /** [daysFromNow, quantity, costPrice] — expiry drives the FEFO ordering. */
  batches: [days: number, quantity: number, costPrice: number][];
  notes?: string;
}

const PRODUCTS: SeedProduct[] = [
  {
    name: 'Gentle Foaming Cleanser',
    sku: 'GL-CLN-001',
    category: 'Cleanser',
    brand: 'GlowLab',
    size: '150ml',
    sellingPrice: 18.5,
    minStockAlert: 6,
    // Nearest lot expires inside the alert window so the dashboard has something
    // urgent to show without being fabricated nonsense.
    batches: [
      [12, 8, 9.2],
      [210, 20, 9.8],
    ],
  },
  {
    name: 'Vitamin C 10% Serum',
    sku: 'GL-SER-002',
    category: 'Serum',
    brand: 'GlowLab',
    size: '30ml',
    sellingPrice: 42,
    minStockAlert: 5,
    batches: [
      [-4, 3, 21.5], // already expired: must never be sold
      [95, 14, 22.0],
    ],
    notes: 'Expired lot quarantined — do not sell.',
  },
  {
    name: 'Niacinamide 5% + Zinc',
    sku: 'GL-SER-003',
    category: 'Serum',
    brand: 'DermaPure',
    size: '30ml',
    sellingPrice: 26.75,
    minStockAlert: 8,
    batches: [
      [45, 25, 12.4],
      [300, 15, 12.9],
    ],
  },
  {
    name: 'Hydrating essence',
    sku: 'GL-TON-004',
    category: 'Toner',
    brand: 'DermaPure',
    size: '200ml',
    sellingPrice: 24,
    minStockAlert: 6,
    batches: [[180, 18, 11.1]],
  },
  {
    name: 'Ceramide Barrier Cream',
    sku: 'GL-MOI-005',
    category: 'Moisturizer',
    brand: 'GlowLab',
    size: '50ml',
    sellingPrice: 34.5,
    minStockAlert: 5,
    // Deliberately below the reorder point so the low-stock queue is populated.
    batches: [[240, 4, 17.0]],
  },
  {
    name: 'Broad Spectrum SPF 50 Fluid',
    sku: 'GL-SUN-006',
    category: 'Sunscreen',
    brand: 'Sunveil',
    size: '50ml',
    sellingPrice: 29.95,
    minStockAlert: 10,
    batches: [
      [25, 9, 13.6], // inside the 30-day expiry window
      [400, 30, 14.2],
    ],
  },
  {
    name: 'Clay detox mask',
    sku: 'GL-MSK-007',
    category: 'Cleanser',
    brand: 'Sunveil',
    size: '75ml',
    sellingPrice: 22,
    minStockAlert: 4,
    batches: [[150, 12, 9.9]],
  },
  {
    name: 'Oatmeal soothing cream',
    sku: 'GL-MOI-008',
    category: 'Moisturizer',
    brand: 'DermaPure',
    size: '100ml',
    sellingPrice: 28,
    minStockAlert: 6,
    batches: [
      [8, 6, 13.0],
      [320, 10, 13.4],
    ],
  },
];

/* ----------------------------------------------------------------- customers */

const CUSTOMERS: {
  name: string;
  phone?: string;
  skinType: string;
  notes?: string;
}[] = [
  { name: 'Amara Osei', phone: '+1 555 0142', skinType: 'Oily', notes: 'Prefers lightweight gel textures.' },
  { name: 'Beatriz Lima', phone: '+1 555 0177', skinType: 'Dry' },
  { name: 'Chen Wei', phone: '5550188', skinType: 'Sensitive', notes: 'Avoid fragrance.' },
  { name: 'Dana Kovács', phone: '+1 555 0199', skinType: 'Acne-Prone' },
  { name: 'Elif Yılmaz', skinType: 'Combination' },
  { name: 'Fatima Zahra', phone: '+1 555 0110', skinType: 'Dry' },
];

/* ---------------------------------------------------------------------- main */

async function main() {
  await connectToDatabase();

  // The owner account is created before the wipe so a missing credential fails
  // fast, before anything has been destroyed. It is *not* in the deleteMany list
  // below: wiping demo data must never lock the shop out of its own app.
  const credentials = ownerCredentialsSchema.safeParse({
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
    displayName: process.env.ADMIN_DISPLAY_NAME ?? 'Shop owner',
  });

  if (!credentials.success) {
    console.error('[seed] ADMIN_USERNAME and ADMIN_PASSWORD are required to create the owner account.');
    console.error(`[seed] ${credentials.error.issues.map((issue) => issue.message).join('; ')}`);
    console.error('[seed] aborting before any data was deleted.');
    process.exit(1);
  }

  const account = await ensureUser(credentials.data);
  console.info(
    account.created
      ? `[seed] created owner account "${credentials.data.username.toLowerCase()}"`
      : `[seed] owner account "${credentials.data.username.toLowerCase()}" already exists — password unchanged`,
  );

  if (process.argv.includes('--owner-only')) {
    console.info(
      `[seed] --owner-only: skipping demo data; no collections were touched. ` +
        `Sign in as "${credentials.data.username.toLowerCase()}".`,
    );
    return;
  }

  console.info('[seed] clearing existing collections…');
  // deleteMany rather than drop, so declared indexes survive.
  await Promise.all([
    Product.deleteMany({}),
    Customer.deleteMany({}),
    Sale.deleteMany({}),
    StockMovement.deleteMany({}),
    FinancialTransaction.deleteMany({}),
  ]);

  console.info('[seed] creating products and batches…');
  const productIds = new Map<string, string>();

  for (const definition of PRODUCTS) {
    const product = await createProduct({
      name: definition.name,
      sku: definition.sku,
      category: definition.category,
      brand: definition.brand,
      size: definition.size,
      sellingPrice: definition.sellingPrice,
      minStockAlert: definition.minStockAlert,
      ...(definition.notes ? { notes: definition.notes } : {}),
      batches: definition.batches.map(([days, quantity, costPrice]) => ({
        batchNumber: `${definition.sku}-${days >= 0 ? '+' : ''}${days}d`,
        expiryDate: addDays(today, days),
        costPrice,
        quantity,
        supplier: SUPPLIER,
      })),
    });

    productIds.set(product.sku, product.id);
  }

  console.info('[seed] creating customers…');
  const customerIds: string[] = [];

  for (const definition of CUSTOMERS) {
    const customer = await createCustomer({
      name: definition.name,
      phone: definition.phone,
      skinType: definition.skinType as Parameters<typeof createCustomer>[0]['skinType'],
      ...(definition.notes ? { notes: definition.notes } : {}),
      isWalkIn: !definition.phone,
    });
    customerIds.push(customer.id);
  }

  console.info('[seed] processing sales through the checkout service…');

  const paymentMethods = ['Cash', 'Bank Transfer', 'Mobile Payment'] as const;
  const skus = [...productIds.keys()];
  const totals = { sales: 0 };

  // Current stock per SKU, kept in step with each sale so the generator can clamp
  // its own requests instead of relying on checkout to reject them.
  const stockBySku = new Map<string, number>();
  const skuByProductId = new Map<string, string>();

  for (const product of await Product.find({}).lean<{ _id: unknown; sku: string; stockQuantity: number }[]>()) {
    stockBySku.set(product.sku, product.stockQuantity);
    skuByProductId.set(String(product._id), product.sku);
  }

  // Ten days of trading, oldest first, so the dashboard's 30-day window and the
  // ledger's period filters both have data to work with.
  for (let daysAgo = 9; daysAgo >= 0; daysAgo -= 1) {
    const salesToday = 2 + Math.floor(random() * 3);

    for (let index = 0; index < salesToday; index += 1) {
      const lineCount = 1 + Math.floor(random() * 3);
      const chosen = new Map<string, number>();

      for (let line = 0; line < lineCount; line += 1) {
        const sku = pick(skus);
        chosen.set(sku, (chosen.get(sku) ?? 0) + 1 + Math.floor(random() * 2));
      }

      const items = [...chosen.entries()]
        .map(([sku, quantity]) => ({
          productId: productIds.get(sku) as string,
          // Never request more than is left: a random generator will happily
          // oversell a small catalogue, and `checkout` (correctly) refuses.
          quantity: Math.min(quantity, stockBySku.get(sku) ?? 0),
        }))
        .filter((item) => item.quantity > 0);

      if (items.length === 0) continue;

      // One in six orders is a walk-in; the rest are attributed so customer
      // history and lifetime-spend stats have something to aggregate.
      const withCustomer = random() < 0.66;

      const result = await checkout({
        items,
        paymentMethod: pick(paymentMethods),
        discountType: random() < 0.2 ? 'percent' : 'none',
        discountValue: random() < 0.2 ? 10 : 0,
        ...(withCustomer ? { customerId: pick(customerIds) } : {}),
        cashier: pick(['Assistant A', 'Assistant B']),
        note: `Day -${daysAgo}`,
      });

      // Keep the running stock map in step with what was just sold.
      for (const item of items) {
        const sku = skuByProductId.get(item.productId);
        if (sku) stockBySku.set(sku, (stockBySku.get(sku) ?? 0) - item.quantity);
      }

      totals.sales += result.total;
    }
  }

  console.info('[seed] recording operating expenses…');

  const expenses: {
    category: 'Supplier Restock' | 'Rent' | 'Utilities' | 'Packaging' | 'Miscellaneous';
    amount: number;
    referenceNote: string;
    paymentMethod: (typeof paymentMethods)[number];
    daysAgo: number;
  }[] = [
    { category: 'Rent', amount: 650, referenceNote: 'Shop rent', paymentMethod: 'Bank Transfer', daysAgo: 9 },
    { category: 'Supplier Restock', amount: 480.5, referenceNote: `${SUPPLIER} invoice #4471`, paymentMethod: 'Bank Transfer', daysAgo: 8 },
    { category: 'Packaging', amount: 62.4, referenceNote: 'Bags, tissue and tape', paymentMethod: 'Cash', daysAgo: 6 },
    { category: 'Utilities', amount: 118.9, referenceNote: 'Electricity and water', paymentMethod: 'Bank Transfer', daysAgo: 5 },
    { category: 'Supplier Restock', amount: 296, referenceNote: `${SUPPLIER} invoice #4489`, paymentMethod: 'Bank Transfer', daysAgo: 3 },
    { category: 'Miscellaneous', amount: 24.99, referenceNote: 'Cleaning supplies', paymentMethod: 'Cash', daysAgo: 2 },
    { category: 'Rent', amount: 650, referenceNote: 'Shop rent', paymentMethod: 'Bank Transfer', daysAgo: 0 },
    { category: 'Packaging', amount: 41.2, referenceNote: 'Gift boxes and ribbon', paymentMethod: 'Cash', daysAgo: 0 },
  ];

  for (const expense of expenses) {
    await recordTransaction({
      type: 'outcome',
      amount: expense.amount,
      category: expense.category,
      paymentMethod: expense.paymentMethod,
      referenceNote: expense.referenceNote,
      occurredAt: addDays(today, -expense.daysAgo),
    });
  }

  // Tag a couple of customers so the recommendation UI is not empty.
  const recommendationPairs: [number, string[]][] = [
    [0, ['GL-SER-003', 'GL-SUN-006']],
    [1, ['GL-MOI-005', 'GL-TON-004']],
    [2, ['GL-CLN-001', 'GL-MOI-008']],
    [3, ['GL-SER-003', 'GL-MSK-007']],
  ];

  for (const [index, skusToTag] of recommendationPairs) {
    const customerId = customerIds[index];
    if (!customerId) continue;
    await Customer.updateOne(
      { _id: customerId },
      {
        $set: {
          recommendedProducts: skusToTag.map((sku) => productIds.get(sku)),
        },
      },
    );
  }

  // Recompute the denormalised stock totals one last time: `checkout` already
  // maintains them, but the summary should reflect the final state exactly.
  const products = await Product.find({}).lean<ProductShape[]>();
  const lowStock = products.filter((product) => product.stockQuantity <= product.minStockAlert);

  const [saleCount, transactionCount, movementCount] = await Promise.all([
    Sale.countDocuments({}),
    FinancialTransaction.countDocuments({}),
    StockMovement.countDocuments({}),
  ]);

  console.info('');
  console.info('[seed] done:');
  console.info(`  products        ${products.length}`);
  console.info(`  customers       ${customerIds.length}`);
  console.info(`  sales           ${saleCount} orders, ${formatMoney(totals.sales)} taken`);
  console.info(`  ledger entries  ${transactionCount} (${expenses.length} manual expenses)`);
  console.info(`  stock movements ${movementCount}`);
  console.info(`  low stock       ${lowStock.length} (${lowStock.map((p) => p.sku).join(', ') || 'none'})`);
  console.info('');
  console.info(`[seed] sign in at http://localhost:3000/login as "${credentials.data.username.toLowerCase()}"`);
}

main()
  .then(async () => {
    await disconnectFromDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error('[seed] failed:', error);
    await disconnectFromDatabase();
    process.exit(1);
  });
