export type AppErrorCode =
  | 'ILLEGAL_TRANSITION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNAUTHORIZED'
  | 'TENANT_VIOLATION'
  | 'VALIDATION_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'EXTERNAL_API_ERROR'
  | 'RATE_LIMITED'
  | 'LLM_INVALID_OUTPUT'
  | 'NOT_GROUNDED'
  | 'CRYPTO_ERROR';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: AppErrorCode, message: string, details: Record<string, unknown> = {}, cause?: unknown) {
    // `cause` is a native Error property, so it is passed through super rather than
    // redeclared as a parameter property.
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export const notFound = (what: string, id: string) =>
  new AppError('NOT_FOUND', `${what} not found: ${id}`, { what, id });

export const forbidden = (why: string, details: Record<string, unknown> = {}) =>
  new AppError('FORBIDDEN', why, details);

/**
 * Raised when a repository lookup finds a row belonging to a different org.
 * A distinct code so isolation breaches are alarmed on rather than logged as 404s.
 */
export const tenantViolation = (entity: string, id: string, expectedOrg: string, actualOrg: string) =>
  new AppError('TENANT_VIOLATION', `${entity} ${id} belongs to org ${actualOrg}, not ${expectedOrg}`, {
    entity,
    id,
    expectedOrg,
    actualOrg,
  });

export const validationFailed = (message: string, details: Record<string, unknown> = {}) =>
  new AppError('VALIDATION_FAILED', message, details);

export const providerUnavailable = (provider: string, reason: string) =>
  new AppError('PROVIDER_UNAVAILABLE', `Provider ${provider} unavailable: ${reason}`, { provider, reason });

export const providerTimeout = (provider: string, ms: number) =>
  new AppError('PROVIDER_TIMEOUT', `Provider ${provider} timed out after ${ms}ms`, { provider, ms });

export const llmInvalidOutput = (reason: string, raw?: string) =>
  new AppError('LLM_INVALID_OUTPUT', `LLM output failed validation: ${reason}`, { reason, raw: raw?.slice(0, 400) });

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError('VALIDATION_FAILED', message, {}, err);
}
