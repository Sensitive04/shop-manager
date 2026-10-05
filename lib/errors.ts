/**
 * Typed application errors.
 *
 * Route handlers translate these into HTTP responses; anything that is not an
 * ApiError is treated as an unexpected bug and reported as a generic 500 so
 * internal details never leak to the client.
 */

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INSUFFICIENT_STOCK'
  | 'DATABASE_ERROR'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INSUFFICIENT_STOCK: 409,
  DATABASE_ERROR: 503,
  INTERNAL_ERROR: 500,
};

export interface FieldIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly issues: FieldIssue[];

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { issues?: FieldIssue[]; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.issues = options.issues ?? [];
  }
}

export class ValidationError extends ApiError {
  constructor(message: string, issues: FieldIssue[] = []) {
    super('VALIDATION_ERROR', message, { issues });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends ApiError {
  constructor(resource = 'Resource') {
    super('NOT_FOUND', `${resource} not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends ApiError {
  constructor(message: string) {
    super('CONFLICT', message);
    this.name = 'ConflictError';
  }
}

export class InsufficientStockError extends ApiError {
  constructor(message: string, issues: FieldIssue[] = []) {
    super('INSUFFICIENT_STOCK', message, { issues });
    this.name = 'InsufficientStockError';
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}