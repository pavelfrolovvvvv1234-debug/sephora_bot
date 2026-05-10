/**
 * Screen renderer for unified message rendering.
 * Provides consistent message formatting across the bot.
 *
 * @module ui/screens/renderer
 */

import { InlineKeyboard } from "grammy";
import type { AppContext } from "../../shared/types/context.js";
import type { RenderedScreen } from "./types.js";

/**
 * Screen renderer options.
 */
export interface RenderOptions {
  title?: string;
  description?: string;
  details?: string[];
  actions?: InlineKeyboard;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
}

/**
 * Screen renderer for creating consistent Telegram messages.
 * Uses FluentContextFlavor's t() method for translations.
 */
export class ScreenRenderer {
  /**
   * Create a screen renderer from context.
   */
  static fromContext(ctx: AppContext): ScreenRenderer {
    return new ScreenRenderer(ctx);
  }

  constructor(private ctx: AppContext) {}

  /**
   * Render a screen with unified formatting.
   * Note: Fluent already returns formatted HTML, so we don't escape it.
   *
   * @param options - Render options
   * @returns Rendered screen
   */
  render(options: RenderOptions): RenderedScreen {
    const parts: string[] = [];

    // Title (optional)
    if (options.title) {
      parts.push(`<b>${options.title}</b>`);
      parts.push("");
    }

    // Description (optional) - can be HTML from Fluent
    if (options.description) {
      parts.push(options.description);
      parts.push("");
    }

    // Details (optional)
    if (options.details && options.details.length > 0) {
      parts.push(...options.details.map((d) => `  • ${d}`));
      parts.push("");
    }

    const text = parts.join("\n").trim() || "";

    return {
      text,
      keyboard: options.actions,
      parse_mode: options.parseMode || "HTML",
    };
  }

  /**
   * Render welcome screen в текущей локали (en/ru).
   */
  renderWelcome(data: { balance: number; locale?: string }): RenderedScreen {
    (this.ctx as any)._requestLocale = data.locale ?? (this.ctx as any)._requestLocale ?? "ru";
    return {
      text: this.ctx.t("welcome", { balance: data.balance }),
      parse_mode: "HTML",
    };
  }

  /**
   * Render profile screen.
   */
  renderProfile(data: { 
    userId: number; 
    userStatus: string; 
    balance: number; 
    whoisStatus: string; 
    emailStatus: string;
  }): RenderedScreen {
    return {
      text: this.ctx.t("profile", {
        userId: data.userId,
        userStatus: data.userStatus,
        balance: data.balance,
        whoisStatus: data.whoisStatus,
        emailStatus: data.emailStatus,
      }),
      parse_mode: undefined, // Plain text for clickable URLs
    };
  }

  /**
   * Render VDS rate screen.
   */
  renderVdsRate(data: {
    rateName: string;
    price: number;
    cpuModel?: string;
    cpu: number;
    ram: number;
    disk: number;
    network: number;
  }): RenderedScreen {
    return this.render({
      description: this.ctx.t("vds-rate-full-view", {
        rateName: data.rateName,
        price: this.formatCurrency(data.price),
        cpuModel: data.cpuModel ?? "Xeon E5-2699v4",
        cpu: data.cpu,
        ram: data.ram,
        disk: data.disk,
        network: data.network,
      }),
    });
  }

  /**
   * Render loading screen.
   */
  renderLoading(message: string): RenderedScreen {
    return this.render({
      description: `⏳ ${message}`,
    });
  }

  /**
   * Render error screen.
   */
  renderError(message: string): RenderedScreen {
    return this.render({
      description: `❌ ${message}`,
    });
  }

  /**
   * Render success screen.
   */
  renderSuccess(message: string): RenderedScreen {
    return this.render({
      description: `✅ ${message}`,
    });
  }

  /**
   * Render confirmation screen.
   */
  renderConfirmation(
    message: string,
    confirmText?: string,
    cancelText?: string
  ): RenderedScreen {
    const { InlineKeyboard } = require("grammy");
    const keyboard = new InlineKeyboard()
      .text(confirmText || this.ctx.t("button-agree"), "confirm")
      .text(cancelText || this.ctx.t("button-close"), "cancel");

    return this.render({
      description: message,
      actions: keyboard,
    });
  }

  /**
   * Format currency.
   */
  private formatCurrency(amount: number): string {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(amount);
  }

  /**
   * Escape HTML special characters.
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}

/**
 * Helper to render screen from context.
 */
export async function renderScreen(
  ctx: AppContext,
  renderFn: (renderer: ScreenRenderer) => RenderedScreen
): Promise<RenderedScreen> {
  const renderer = ScreenRenderer.fromContext(ctx);
  return renderFn(renderer);
}
