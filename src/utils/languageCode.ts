// The Voices API takes a BCP-47 language tag ("en-US", "pt-BR"). Callers (and
// the wizard LLM) may write it with an underscore ("en_US") or odd casing, so
// everything is canonicalised to the hyphenated form; anything that isn't
// recognisably a language tag becomes undefined (treated as "not set").
const LANGUAGE_TAG = /^([a-zA-Z]{2,3})(?:[-_]([a-zA-Z]{4}))?(?:[-_]([a-zA-Z]{2}|\d{3}))?$/;

export function normalizeLanguageCode(input: string): string | undefined {
  const match = LANGUAGE_TAG.exec(input.trim());
  if (!match) return undefined;
  const [, language, script, region] = match;
  return [
    (language as string).toLowerCase(),
    script ? script[0]?.toUpperCase() + script.slice(1).toLowerCase() : undefined,
    region?.toUpperCase(),
  ]
    .filter(Boolean)
    .join("-");
}
