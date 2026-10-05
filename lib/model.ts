import { model, models, type Model, type Schema } from 'mongoose';

/**
 * Reuse an already-compiled model, or compile it on first import.
 *
 * Next.js hot-reloads modules in development, which re-executes every model
 * file. Calling `model()` a second time for the same name throws
 * `OverwriteModelError`, so the cached instance has to be reused.
 *
 * PERFORMANCE TRAP — do not "simplify" this to `model<T>(name, schema)`.
 * Calling the *generic* mongoose factory from inside a generic function makes
 * TypeScript re-instantiate mongoose's `model()` overload machinery for every
 * call site, with the caller's full document type. On this schema that pushed
 * type-checking past a 3 GB heap and killed the compiler. Calling the
 * non-generic overload and asserting the result once keeps the document type
 * intact at every call site and compiles in seconds.
 *
 * The `models[name]` cast is deliberate: indexing `models` alone yields
 * `Model<any>`, which would silently discard the document type.
 */
export function modelFrom<T>(name: string, schema: Schema): Model<T> {
  const existing = models[name] as Model<T> | undefined;
  // `unknown` first: `Model<any>` and `Model<T>` do not sufficiently overlap
  // for a direct assertion.
  return existing ?? (model(name, schema) as unknown as Model<T>);
}