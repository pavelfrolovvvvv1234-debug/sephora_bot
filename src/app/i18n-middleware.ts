/**
 * Ранний резолвер локали и изолированный i18n без мутаций useLocale.
 * Локаль устанавливается один раз в начале апдейта, до любого reply/edit.
 *
 * @module app/i18n-middleware
 */

import type { Fluent } from "@moebius/fluent";
import type { AppContext } from "../shared/types/context.js";
import type { SessionData } from "../shared/types/session.js";

const normalizeI18nText = (value: string): string =>
  value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");

export interface EarlyLocaleResolverOptions {
  resolveLocale(ctx: AppContext, session: SessionData, loadedUser: { lang?: string | null } | null): "ru" | "en";
}

/**
 * Early locale resolver: гарантирует session.main.locale до любого рендера.
 * Запускать сразу после load user.
 * Для нового юзера без lang — берём ctx.from?.language_code, сохраняем в DB.
 */
export function createEarlyLocaleResolver(): (ctx: AppContext, next: () => Promise<void>) => Promise<void> {
  return async (ctx, next) => {
    const session = (await ctx.session) as SessionData;
    if (!session?.main) return next();

    const loadedUser = (ctx as any).loadedUser;
    const currentLocale = session.main.locale;
    let locale: "ru" | "en";

    // Приоритет: loadedUser.lang (БД) > session.main.locale > ctx.from.language_code
    if (loadedUser?.lang === "ru" || loadedUser?.lang === "en") {
      locale = loadedUser.lang as "ru" | "en";
      session.main.locale = locale;
    } else if (currentLocale === "ru" || currentLocale === "en") {
      locale = currentLocale;
    } else {
      // По умолчанию русский — чтобы в RU-версии бота не было английского приветствия
      locale = "ru";
      session.main.locale = locale;
      if (loadedUser && ctx.appDataSource && session.main.user.id > 0) {
        try {
          const userRepo = ctx.appDataSource.getRepository(
            (await import("../entities/User.js")).default
          );
          await userRepo.update({ id: session.main.user.id }, { lang: locale });
          loadedUser.lang = locale;
        } catch {
          // ignore
        }
      }
    }

    return next();
  };
}

/**
 * i18n middleware с двумя Fluent-инстансами — без useLocale, без гонок.
 * translateForLocale(locale, key, vars) — для перерисовки при смене языка в том же апдейте.
 */
export function createI18nMiddleware(fluentRu: Fluent, fluentEn: Fluent) {
  return async (ctx: AppContext, next: () => Promise<void>) => {
    const session = (await ctx.session) as SessionData;
    const locale = session?.main?.locale === "en" ? "en" : "ru";
    const fluent = locale === "en" ? fluentEn : fluentRu;
    const translate = fluent.translate.bind(fluent, locale);

    const translateForLocale = (loc: string, key: string, vars?: Record<string, string | number>) => {
      const f = loc === "en" ? fluentEn : fluentRu;
      return normalizeI18nText(String(f.translate(loc, key, vars ?? {})));
    };

    (ctx as any).fluent = {
      instance: fluent,
      useLocale: () => {},
      translate: (localeOrKey: string, keyOrVars?: string | Record<string, string | number>, vars?: Record<string, string | number>) => {
        if (localeOrKey === "ru" || localeOrKey === "en") {
          return translateForLocale(localeOrKey, keyOrVars as string ?? "", vars ?? {});
        }
        return normalizeI18nText(String(translate(localeOrKey, (keyOrVars as Record<string, string | number>) ?? {})));
      },
      translateForLocale,
    };
    (ctx as any).t = (key: string, vars?: Record<string, string | number>) =>
      normalizeI18nText(String(translate(key, vars ?? {})));

    return next();
  };
}
