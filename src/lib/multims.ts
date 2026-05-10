import legacyMs, { type StringValue } from "ms";

/**
 * Return undefined in case if input was wrong
 * @param input String value for parse
 * @returns {Number | undefined}
 */
export default function ms(input: string) {
  const i = input
    .replaceAll("г", "y")
    .replaceAll("год", "y")
    .replaceAll("д", "d")
    .replaceAll("день", "d")
    .replaceAll("час", "h")
    .replaceAll("ч", "h");

  return legacyMs(i as StringValue);
}
