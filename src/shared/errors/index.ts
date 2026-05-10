/**
 * Custom error classes for application errors.
 *
 * @module shared/errors
 */

/**
 * Base application error class.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Business logic error (user-facing).
 */
export class BusinessError extends AppError {
  constructor(message: string, code: string = "BUSINESS_ERROR") {
    super(message, code, 400);
  }
}

/**
 * Validation error.
 */
export class ValidationError extends AppError {
  constructor(message: string, public readonly field?: string) {
    super(message, "VALIDATION_ERROR", 400);
  }
}

/**
 * Not found error.
 */
export class NotFoundError extends AppError {
  constructor(resource: string, identifier?: string | number) {
    const message = identifier
      ? `${resource} with id "${identifier}" not found`
      : `${resource} not found`;
    super(message, "NOT_FOUND", 404);
  }
}

/**
 * Payment provider error.
 */
export class PaymentError extends AppError {
  constructor(message: string, public readonly provider: string) {
    super(message, "PAYMENT_ERROR", 502);
  }
}

/**
 * External API error (VMManager, etc.).
 */
export class ExternalApiError extends AppError {
  constructor(
    message: string,
    public readonly service: string,
    public readonly originalError?: unknown
  ) {
    super(message, "EXTERNAL_API_ERROR", 502);
  }
}
