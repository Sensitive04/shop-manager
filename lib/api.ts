import 'server-only';

import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { ApiError, isApiError } from '@/lib/errors';
import type { ApiFailure, ApiResponse } from '@/types/api';

/**
 * Uniform API responses.
 *
 * Every endpoint answers with `{ ok, data }` or `{ ok, error }` so the client
 * has exactly one branch to write, and unexpected failures never surface raw
 * driver or stack details.
 */

export function ok<T>(data: T, init?: ResponseInit): NextResponse<ApiResponse<T>> {
  return NextResponse.json({ ok: true as const, data }, init);
}

export function created<T>(data: T): NextResponse<ApiResponse<T>> {
  return NextResponse.json({ ok: true as const, data }, { status: 201 });
}

export function failure(error: ApiError): NextResponse<ApiFailure> {
  return NextResponse.json(
    {
      ok: false as const,
      error: {
        code: error.code,
        message: error.message,
        ...(error.issues.length > 0 ? { issues: error.issues } : {}),
      },
    },
    { status: error.status },
  );
}

/** Flatten a ZodError into the transport issue shape. */
export function zodIssues(error: ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/**
 * Wrap a route handler so thrown errors become well-formed responses.
 *
 * Duplicate-key violations are translated to a 409, since a unique index on
 * SKU or phone is the most likely user-facing conflict in this app.
 */
export function handleRoute<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Promise<NextResponse>,
): (...args: TArgs) => Promise<NextResponse> {
  return async (...args: TArgs) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof ZodError) {
        return failure(
          new ApiError('VALIDATION_ERROR', 'The request body is invalid.', {
            issues: zodIssues(error),
          }),
        );
      }

      if (isApiError(error)) {
        return failure(error);
      }

      if (isDuplicateKeyError(error)) {
        return failure(
          new ApiError('CONFLICT', 'A record with these details already exists.'),
        );
      }

      console.error('[api] unhandled error:', error);
      return failure(
        new ApiError('INTERNAL_ERROR', 'Something went wrong handling that request.'),
      );
    }
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === 11000 ||
    (typeof candidate.message === 'string' && candidate.message.includes('E11000'))
  );
}

/** Read and JSON-parse a request body, converting malformed JSON to a 400. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError('BAD_REQUEST', 'Request body must be valid JSON.');
  }
}

/** Parse `?page`/`?limit` query params with sane bounds. */
export function parsePagination(url: URL, defaultLimit = 25) {
  const rawPage = Number(url.searchParams.get('page') ?? '1');
  const rawLimit = Number(url.searchParams.get('limit') ?? String(defaultLimit));

  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), 200) : defaultLimit;

  const skip = (page - 1) * limit;
  return { page, limit, skip };
}