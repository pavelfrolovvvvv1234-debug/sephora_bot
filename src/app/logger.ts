/**
 * Centralized logging utility.
 *
 * @module app/logger
 */

import { isDevelopment } from "./config";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Logger class for structured logging.
 */
export class Logger {
  private static minLevel: LogLevel = isDevelopment()
    ? LogLevel.DEBUG
    : LogLevel.INFO;

  private static formatMessage(level: string, message: string, ...args: unknown[]): string {
    const timestamp = new Date().toISOString();
    const context = args.length > 0 ? ` ${JSON.stringify(args)}` : "";
    return `[${timestamp}] [${level}] ${message}${context}`;
  }

  static debug(message: string, ...args: unknown[]): void {
    if (this.minLevel <= LogLevel.DEBUG) {
      console.debug(this.formatMessage("DEBUG", message, ...args));
    }
  }

  static info(message: string, ...args: unknown[]): void {
    if (this.minLevel <= LogLevel.INFO) {
      console.info(this.formatMessage("INFO", message, ...args));
    }
  }

  static warn(message: string, ...args: unknown[]): void {
    if (this.minLevel <= LogLevel.WARN) {
      console.warn(this.formatMessage("WARN", message, ...args));
    }
  }

  static error(message: string, error?: Error | unknown, ...args: unknown[]): void {
    if (this.minLevel <= LogLevel.ERROR) {
      const errorDetails =
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : error;
      console.error(this.formatMessage("ERROR", message, errorDetails, ...args));
    }
  }
}
