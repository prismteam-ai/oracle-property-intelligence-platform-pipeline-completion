import type { ApiErrorCode } from './runtime.js';

const messages: Readonly<Record<ApiErrorCode, string>> = Object.freeze({
  INVALID_REQUEST: 'The request does not match the operation contract.',
  REQUEST_TOO_LARGE: 'The request exceeds the 16 KiB limit.',
  RESPONSE_TOO_LARGE: 'The bounded response limit was exceeded.',
  UNKNOWN_OPERATION: 'The requested operation does not exist.',
  METHOD_NOT_ALLOWED: 'This operation requires POST with application/json.',
  ORIGIN_NOT_ALLOWED: 'The request origin is not allowed.',
  RELEASE_MISMATCH: 'The immutable release does not match the request.',
  STALE_CURSOR: 'The cursor is invalid, stale, or belongs to another release.',
  QUERY_BUDGET_EXCEEDED: 'The bounded query budget was exceeded.',
  DATA_CORRUPTION: 'The verified release returned inconsistent data.',
  AGENT_UNAVAILABLE: 'The no-fallback agent is unavailable for this release.',
  SERVICE_UNAVAILABLE: 'No verified immutable production release is configured.',
  INTERNAL_ERROR: 'The request could not be completed.',
});

export class ApiFailure extends Error {
  public readonly code: ApiErrorCode;

  public constructor(code: ApiErrorCode) {
    super(messages[code]);
    this.name = 'ApiFailure';
    this.code = code;
  }
}

export function publicMessage(code: ApiErrorCode): string {
  return messages[code];
}

export function statusFor(code: ApiErrorCode): number {
  switch (code) {
    case 'INVALID_REQUEST':
      return 400;
    case 'ORIGIN_NOT_ALLOWED':
      return 403;
    case 'UNKNOWN_OPERATION':
      return 404;
    case 'METHOD_NOT_ALLOWED':
      return 405;
    case 'RELEASE_MISMATCH':
    case 'STALE_CURSOR':
      return 409;
    case 'REQUEST_TOO_LARGE':
      return 413;
    case 'QUERY_BUDGET_EXCEEDED':
      return 429;
    case 'AGENT_UNAVAILABLE':
    case 'SERVICE_UNAVAILABLE':
    case 'DATA_CORRUPTION':
      return 503;
    case 'RESPONSE_TOO_LARGE':
      return 502;
    case 'INTERNAL_ERROR':
      return 500;
  }
}
