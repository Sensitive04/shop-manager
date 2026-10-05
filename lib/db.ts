import 'server-only';

import mongoose, { type ClientSession } from 'mongoose';

/**
 * MongoDB connection management.
 *
 * Three things make this less trivial than a single `mongoose.connect()`:
 *
 *  1. Next.js dev hot-reloads modules, which would otherwise open a new pool on
 *     every edit until Mongo refuses connections. The connection is cached on
 *     globalThis.
 *
 *  2. POS checkout needs multi-document transactions, and those require a
 *     replica set. The docker-compose stack runs a single-node replica set; for
 *     local development without Docker we start an in-process single-node
 *     replica set via mongodb-memory-server, so the *same* transactional code
 *     path runs in both environments rather than silently diverging.
 *
 *  3. Serverless hosts (Netlify Functions) scale horizontally, so pool settings
 *     that are sensible for one long-lived process will exhaust the database's
 *     connection limit: fifty concurrent function instances at ten connections
 *     each is five hundred sockets. {@link poolOptions} retunes this when it
 *     detects a serverless runtime, and closes idle sockets promptly so a
 *     frozen function does not hold its share of the limit while asleep.
 */

type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  memoryServer: { stop: () => Promise<boolean> } | null;
};

const globalForMongoose = globalThis as unknown as {
  __shopManagerMongoose?: MongooseCache;
};

const cache: MongooseCache = (globalForMongoose.__shopManagerMongoose ??= {
  conn: null,
  promise: null,
  memoryServer: null,
});

/** Cached result of the transaction-capability probe. Null = not yet checked. */
let transactionSupport: boolean | null = null;

/**
 * Database name used when MONGODB_URI names none.
 *
 * An Atlas SRV string usually ends in a bare `/`, which leaves the database
 * unset; without this the driver quietly writes every sale to a database called
 * `test`. Pinning it here keeps the name explicit wherever the URI came from.
 */
const DEFAULT_DB_NAME = 'shopmanager';

function isEnabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['false', '0', 'no'].includes(value.toLowerCase());
}

/**
 * Resolve MONGODB_URI, or explain precisely why it cannot be resolved.
 *
 * Exported for tests. Nothing here connects, so it is safe to call without a
 * database. Kept separate from {@link connectToDatabase} because the failure that
 * matters most in production is a misconfigured URI, and that should be assertable
 * without standing up a replica set.
 */
export function resolveConnectionSettings(
  env: Record<string, string | undefined> = process.env,
): {
  uri: string | null;
  memoryFallbackAllowed: boolean;
  dbName: string;
  error: string | null;
} {
  const uri = env.MONGODB_URI?.trim() || null;
  const memoryFallbackAllowed = isEnabled(env.MONGODB_MEMORY_FALLBACK, true);
  const dbName = env.MONGODB_DB_NAME?.trim() || DEFAULT_DB_NAME;

  if (uri) return { uri, memoryFallbackAllowed, dbName, error: null };

  const error = memoryFallbackAllowed
    ? null
    : 'MONGODB_URI is not set and the in-memory fallback is disabled ' +
      '(MONGODB_MEMORY_FALLBACK=false). Set MONGODB_URI to a replica set ' +
      'connection string, e.g. mongodb+srv://user:password@cluster.example.net/ ' +
      '— a replica set is required because POS checkout uses transactions.';

  return { uri, memoryFallbackAllowed, dbName, error };
}

/**
 * Whether we are running as a short-lived serverless function.
 *
 * Netlify and Vercel both expose one of these. Detection matters because the
 * two environments want opposite connection settings, not because serverless
 * cannot reach MongoDB.
 */
function isServerless(): boolean {
  return Boolean(process.env.NETLIFY || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

/**
 * Connection pool tuned for the current environment.
 *
 * On a normal long-lived server the pool can stay wide. On serverless it cannot:
 * the database's connection limit is shared across every concurrent instance, and
 * Atlas Free allows only 500 in total. A single shop's traffic needs a handful of
 * sockets, not ten per instance, so the pool is capped low and idle sockets are
 * closed after a few seconds. That last part is what lets a frozen function stop
 * holding its share of the limit, and it is also what makes the instance eligible
 * to be frozen in the first place — a live socket keeps a function awake and
 * billable.
 */
function poolOptions(): {
  maxPoolSize: number;
  minPoolSize: number;
  maxIdleTimeMS: number;
  serverSelectionTimeoutMS: number;
} {
  if (isServerless()) {
    return {
      // One socket per instance: requests within an instance serialise through
      // it, which is fine at shop scale and keeps the global total small.
      maxPoolSize: 1,
      // Never hold a socket open speculatively while idle.
      minPoolSize: 0,
      maxIdleTimeMS: 5_000,
      // Fail fast so a request errors visibly rather than hitting the host's
      // function timeout with a confusing 504.
      serverSelectionTimeoutMS: 8_000,
    };
  }

  return {
    maxPoolSize: 10,
    minPoolSize: 0,
    maxIdleTimeMS: 60_000,
    serverSelectionTimeoutMS: 10_000,
  };
}

/**
 * Start an in-process single-node replica set. Development only.
 *
 * The specifier is deliberately indirect. A literal `import('mongodb-memory-server')`
 * is statically analysed by Turbopack and must resolve at build time, so a
 * production build without devDependencies installed fails on an import that
 * would never execute. Building the specifier at runtime keeps the package out
 * of the module graph entirely — the development fallback keeps working, and the
 * production bundle never has to know the package exists.
 */
async function startMemoryReplicaSet(): Promise<string> {
  const specifier = ['mongodb', 'memory', 'server'].join('-');

  try {
    const mod = (await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ specifier)) as {
      MongoMemoryReplSet: {
        create: (options: unknown) => Promise<{ getUri: () => string; stop: () => Promise<boolean> }>;
      };
    };

    const replSet = await mod.MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    cache.memoryServer = replSet;
    return replSet.getUri();
  } catch (error) {
    throw new Error(
      'MONGODB_URI is not set and the in-memory development fallback could not be ' +
        `started: ${error instanceof Error ? error.message : String(error)}. ` +
        'Set MONGODB_URI, or run `npm install` so devDependencies are present.',
    );
  }
}

async function resolveUri(): Promise<string> {
  const settings = resolveConnectionSettings();

  if (settings.uri) return settings.uri;

  if (settings.error) {
    // A throwaway database in production would silently lose every sale, so a
    // missing MONGODB_URI has to be a loud failure rather than a quiet default.
    throw new Error(settings.error);
  }

  const uri = await startMemoryReplicaSet();
  console.info('[db] MONGODB_URI not set — started in-memory replica set for development.');
  return uri;
}

/** Connect (once) and return the shared Mongoose instance. */
export async function connectToDatabase(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;

  cache.promise ??= (async () => {
    const uri = await resolveUri();
    mongoose.set('strictQuery', true);

    const conn = await mongoose.connect(uri, {
      ...poolOptions(),
      // A bare `mongodb+srv://…/` connection string names no database, and
      // without this the driver silently writes everything to `test`.
      dbName: resolveConnectionSettings().dbName,
    });

    cache.conn = conn;
    return conn;
  })().catch((error: unknown) => {
    // Clear the memoised rejection so a later request can retry rather than
    // replaying the same failure forever.
    cache.promise = null;
    throw error;
  });

  return cache.promise;
}

/**
 * Whether the connected deployment can run multi-document transactions.
 *
 * A standalone mongod cannot. Rather than crashing at checkout we degrade to
 * non-transactional writes, and the caller's guarded/compensating logic takes
 * over. Both the compose replica set and the in-memory replica set report true.
 *
 * Detected via the `hello` command rather than by reading client options: a
 * replica set can be reached with or without `?replicaSet=` in the URI, so the
 * URI alone is not a reliable signal. The answer cannot change for the life of
 * a connection, so it is cached.
 */
export async function supportsTransactions(): Promise<boolean> {
  if (transactionSupport !== null) return transactionSupport;

  const conn = await connectToDatabase();
  const db = conn.connection.db;

  if (!db) {
    transactionSupport = false;
    return transactionSupport;
  }

  try {
    // Driver v7's `command()` takes no type argument; the result is typed as a
    // document, so the fields we rely on are read defensively.
    const hello = (await db.admin().command({ hello: 1 })) as {
      setName?: string;
      msg?: string;
    };
    // `setName` is present on replica-set members; `isdbgrid` identifies mongos.
    transactionSupport = Boolean(hello.setName) || hello.msg === 'isdbgrid';
  } catch {
    transactionSupport = false;
  }

  return transactionSupport;
}

/**
 * Run `fn` inside a transaction when the deployment supports one.
 *
 * `fn` receives a session that must be threaded into every Mongoose call it
 * makes, otherwise those writes escape the transaction. Falls back to running
 * `fn(undefined)` when transactions are unavailable.
 */
export async function withTransaction<T>(
  fn: (session: ClientSession | undefined) => Promise<T>,
): Promise<T> {
  const conn = await connectToDatabase();

  if (!(await supportsTransactions())) {
    return fn(undefined);
  }

  // MongoDB driver v7 returns a promise from startSession().
  const session = await conn.connection.startSession();

  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    // withTransaction throws rather than returning without invoking the
    // callback, so `result` is always assigned when we get here.
    return result as T;
  } finally {
    await session.endSession();
  }
}

/** Close the connection. Used by tests and graceful shutdown. */
export async function disconnectFromDatabase(): Promise<void> {
  transactionSupport = null;

  if (cache.memoryServer) {
    await cache.memoryServer.stop();
    cache.memoryServer = null;
  }
  cache.promise = null;
  cache.conn = null;
  await mongoose.disconnect();
}

/** Convenience for models: resolve a possibly-lean ObjectId to a hex string. */
export function toIdString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && '_id' in value) {
    return String((value as { _id: unknown })._id);
  }
  if (value && typeof value === 'object' && 'toString' in value) {
    return String(value);
  }
  return null;
}