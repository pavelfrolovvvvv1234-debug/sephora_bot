/**
 * Render template with variables (RU/EN) and optional buttons.
 *
 * @module modules/automations/engine/template-renderer
 */

import type { TemplateConfig } from "../schemas/scenario-config.schema.js";

export function renderTemplate(
  template: TemplateConfig,
  lang: "ru" | "en",
  variables: Record<string, string | number>
): { text: string; buttons?: Array<{ text: string; url?: string; callback_data?: string }> } {
  const content = lang === "ru" ? template.ru : (template.en ?? template.ru);
  let text = content.text;
  for (const [key, value] of Object.entries(variables)) {
    text = text.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"), String(value));
  }
  const buttons = content.buttons?.map((b) => {
    if (b.action === "url") {
      return { text: b.text, url: b.payload };
    }
    if (b.action === "callback") {
      return { text: b.text, callback_data: b.payload };
    }
    return { text: b.text, url: b.payload };
  });
  return { text, buttons };
}
