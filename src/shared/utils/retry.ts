/**
 * Retry utility for external API calls.
 *
 * @module shared/utils/retry
 */

import { Logger } from "../../app/logger";

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  exponentialBackoff?: boolean;
  onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * Retry a function with exponential backoff.
 *
 * @param fn - Function to retry
 * @param options - Retry options
 * @returns Result of the function
 * @throws Last error if all retries failed
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    delayMs = 1000,
    exponentialBackoff = true,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts) {
        Logger.warn(`Retry failed after ${maxAttempts} attempts`, { error });
        throw error;
      }

      const delay = exponentialBackoff
        ? delayMs * Math.pow(2, attempt - 1)
        : delayMs;

      Logger.debug(`Retry attempt ${attempt}/${maxAttempts} after ${delay}ms`, {
        error,
      });

      if (onRetry) {
        onRetry(attempt, error);
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
