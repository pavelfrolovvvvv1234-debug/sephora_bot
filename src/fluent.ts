import { Fluent } from "@moebius/fluent";
import { join } from "node:path";

/** Type for Fluent instance used for translations (e.g. in PaymentStatusChecker, ExpirationService). */
export type FluentTranslator = Fluent;

function pathToFtl(lang: string, name: string) {
  return join(process.cwd(), "locales", lang, name);
}

export async function initFluent(): Promise<{
  fluent: Fluent;
  fluentRu: Fluent;
  fluentEn: Fluent;
  availableLocales: string[];
}> {
  const fluent = new Fluent();

  await fluent.addTranslation({
    locales: "ru",
    filePath: [
      pathToFtl("ru", "translation.ftl"),
      pathToFtl("ru", "services.ftl"),
    ],
    isDefault: true,
    bundleOptions: {
      useIsolating: false,
    },
  });

  await fluent.addTranslation({
    locales: "en",
    filePath: [
      pathToFtl("en", "translation.ftl"),
      pathToFtl("en", "services.ftl"),
    ],
    isDefault: false,
    bundleOptions: {
      useIsolating: false,
    },
  });

  return {
    fluent,
    fluentRu: fluent,
    fluentEn: fluent,
    availableLocales: ["en", "ru"],
  };
}
