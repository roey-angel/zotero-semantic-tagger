import { config } from "../../package.json";

const PREFS = config.prefsPrefix;

/**
 * The built-in system prompt. Used whenever the user has not set one in
 * Settings → Semantic Tagger, so improvements to it reach users who never
 * edited their prompt.
 *
 * Placeholders are substituted at call time by `renderSystemPrompt`.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are a scientific literature tagger. Your task is to select tags from a provided library that best describe a given paper.

RULES:
1. You may ONLY use tags from the provided library — never invent new tags.
2. Select between {{tagMin}} and {{tagMax}} tags. Stay within this range — it is set by the user's strictness preference.
3. {{strictnessInstruction}}
4. Ignore the references/bibliography section of the paper — do not use cited works to infer tags.
5. Return ONLY a JSON array of tag strings, exactly as they appear in the library. No explanation.
{{synonymGroups}}`;

interface StrictnessRule {
  tagMin: number;
  tagMax: number;
  instruction: string;
}

/**
 * Maps the strictness slider (0 = very lax, 100 = very strict) onto a tag
 * count range and the matching selection instruction.
 */
export function strictnessRule(strictness: number): StrictnessRule {
  if (strictness > 66) {
    return {
      tagMin: 2,
      tagMax: 4,
      instruction:
        "Be very strict: select AT MOST 4 tags (ideally 2–3). Only apply a tag if it describes a central research topic of the paper — something the paper directly investigates, develops, or makes a primary contribution to. If unsure, leave it out.",
    };
  }
  if (strictness > 33) {
    return {
      tagMin: 4,
      tagMax: 7,
      instruction:
        "Be moderate: select 4–7 tags. Apply a tag if the paper substantially discusses or relies on the concept, even if it is not the primary focus.",
    };
  }
  return {
    tagMin: 6,
    tagMax: 12,
    instruction:
      "Be broad: select 6–12 tags. Apply a tag if the paper meaningfully mentions, uses, or engages with the concept — even in passing, as background, or in the methods section.",
  };
}

export interface PromptContext {
  strictness: number;
  synonymGroups: string[][];
}

/**
 * Fills the placeholders of a system prompt template. Unknown placeholders are
 * left untouched; a template that drops a placeholder simply loses that part.
 */
export function renderSystemPrompt(
  template: string,
  context: PromptContext,
): string {
  const { tagMin, tagMax, instruction } = strictnessRule(context.strictness);

  const synonymSection =
    context.synonymGroups.length > 0
      ? `Synonym groups (treat all entries in a group as equivalent):\n${context.synonymGroups
          .map((g) => g.join("; "))
          .join("\n")}`
      : "";

  const values: Record<string, string> = {
    tagMin: String(tagMin),
    tagMax: String(tagMax),
    strictnessInstruction: instruction,
    synonymGroups: synonymSection,
  };

  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
      name in values ? values[name] : match,
    )
    .trim();
}

/**
 * The user's system prompt, or the built-in default when the pref is unset.
 */
export function getSystemPromptTemplate(): string {
  const custom =
    (Zotero.Prefs.get(`${PREFS}.systemPrompt`, true) as string) ?? "";
  return custom.trim() ? custom : DEFAULT_SYSTEM_PROMPT;
}

/**
 * Builds the system prompt actually sent to the API.
 */
export function buildSystemPrompt(context: PromptContext): string {
  return renderSystemPrompt(getSystemPromptTemplate(), context);
}
