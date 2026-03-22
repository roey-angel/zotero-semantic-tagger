import { config } from "../../package.json";
import { extractPdfText, getPdfPath, resolvePythonScript } from "./pdfExtractor";
import { loadSynonyms } from "./synonyms";

const TOKEN_WARN_THRESHOLD = 20_000;
let _sessionTokens = 0;
let _sessionPaused = false;

const PREFS = config.prefsPrefix;

/**
 * Returns all unique tags currently in the user's Zotero library.
 */
async function getLibraryTags(): Promise<string[]> {
  const tagObjects = await Zotero.Tags.getAll(Zotero.Libraries.userLibraryID);
  return tagObjects.map((t) => t.tag);
}

/**
 * Main entry point: tags a single Zotero item.
 * Orchestrates data collection → Claude API → tag writing.
 */
export async function tagItem(item: Zotero.Item): Promise<void> {
  if (!item.isRegularItem()) return;

  if (_sessionPaused) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({ text: "Tagging paused (session token budget reached)", type: "default" })
      .show()
      .startCloseTimer(4000);
    return;
  }

  const apiKey = Zotero.Prefs.get(`${PREFS}.apiKey`, true) as string;
  if (!apiKey) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({ text: "No API key set — open Settings → Semantic Tagger", type: "fail" })
      .show()
      .startCloseTimer(6000);
    return;
  }

  const strictness = (Zotero.Prefs.get(`${PREFS}.strictness`, true) as number) ?? 50;
  const synonymFilePath = Zotero.Prefs.get(`${PREFS}.synonymFile`, true) as string;
  const pythonPath = (Zotero.Prefs.get(`${PREFS}.pythonPath`, true) as string) || "python3";
  const scriptPath = (Zotero.Prefs.get(`${PREFS}.scriptPath`, true) as string) || "";

  const title = item.getField("title") as string;
  const abstract = item.getField("abstractNote") as string;

  // Collect PDF text using bundled script (or user-configured override)
  let pdfText: string | null = null;
  const resolvedScriptPath = await resolvePythonScript(scriptPath);
  if (resolvedScriptPath) {
    const pdfPath = await getPdfPath(item);
    if (pdfPath) {
      const result = await extractPdfText(pdfPath, pythonPath, resolvedScriptPath);
      pdfText = result.text;
      if (result.warning) {
        new ztoolkit.ProgressWindow(addon.data.config.addonName)
          .createLine({ text: result.warning, type: "fail" })
          .show()
          .startCloseTimer(6000);
      }
    }
  }

  // Require at least title or abstract or PDF text
  if (!title && !abstract && !pdfText) {
    ztoolkit.log(`[SemanticTagger] Item ${item.id}: no content to analyze.`);
    return;
  }

  const libraryTags = await getLibraryTags();
  if (libraryTags.length === 0) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({ text: "No tags in library — add tags to Zotero first", type: "fail" })
      .show()
      .startCloseTimer(6000);
    return;
  }

  const synonymGroups = synonymFilePath ? await loadSynonyms(synonymFilePath) : [];

  const { tags: matchedTags, inputTokens, outputTokens, apiError } = await queryClaudeForTags({
    apiKey: apiKey.trim(),
    title,
    abstract,
    pdfText,
    libraryTags,
    synonymGroups,
    strictness,
  });

  if (apiError) return; // notification already shown inside queryClaudeForTags

  // Session token tracking
  _sessionTokens += inputTokens + outputTokens;
  if (_sessionTokens >= TOKEN_WARN_THRESHOLD) {
    const win = Zotero.getMainWindow();
    const cont = win?.confirm(
      `Semantic Tagger has used ${_sessionTokens.toLocaleString()} tokens this session (budget: ${TOKEN_WARN_THRESHOLD.toLocaleString()}).\n\nContinue tagging?`,
    );
    if (!cont) {
      _sessionPaused = true;
    }
  }

  if (matchedTags.length === 0) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({ text: "No matching tags found in your library", type: "default" })
      .show()
      .startCloseTimer(4000);
    return;
  }

  // Apply matched tags (only from existing library, non-destructively)
  const libraryTagSet = new Set(libraryTags.map((t) => t.toLowerCase()));
  let applied = 0;
  for (const tag of matchedTags) {
    if (libraryTagSet.has(tag.toLowerCase())) {
      item.addTag(tag);
      applied++;
    }
  }

  if (applied > 0) {
    await item.saveTx();
    ztoolkit.log(`[SemanticTagger] Item ${item.id}: applied ${applied} tag(s): ${matchedTags.join(", ")}`);
  }
}

interface ClaudeTagQuery {
  apiKey: string;
  title: string;
  abstract: string;
  pdfText: string | null;
  libraryTags: string[];
  synonymGroups: string[][];
  strictness: number; // 0 (very lax) to 100 (very strict)
}

interface ClaudeTagResult {
  tags: string[];
  inputTokens: number;
  outputTokens: number;
  apiError: boolean;
}

async function queryClaudeForTags(query: ClaudeTagQuery): Promise<ClaudeTagResult> {
  const { apiKey, title, abstract, pdfText, libraryTags, synonymGroups, strictness } = query;

  const strictnessInstruction =
    strictness > 66
      ? "Be conservative: only apply a tag if the paper's main topic clearly and directly relates to it."
      : strictness > 33
      ? "Be moderate: apply a tag if the paper substantially discusses the concept, even if it's not the primary focus."
      : "Be inclusive: apply a tag if the paper meaningfully mentions or engages with the concept.";

  const synonymSection =
    synonymGroups.length > 0
      ? `\nSynonym groups (treat all entries in a group as equivalent):\n${synonymGroups
          .map((g) => g.join("; "))
          .join("\n")}`
      : "";

  const contentParts: string[] = [];
  if (title) contentParts.push(`Title: ${title}`);
  if (abstract) contentParts.push(`Abstract: ${abstract}`);
  if (pdfText) contentParts.push(`PDF text (excerpt):\n${pdfText.slice(0, 8000)}`);

  const systemPrompt = `You are a scientific literature tagger. Your task is to select tags from a provided library that best describe a given paper.

RULES:
1. You may ONLY use tags from the provided library — never invent new tags.
2. Select between 3 and 10 tags. Fewer is better if the paper is narrow.
3. ${strictnessInstruction}
4. Ignore the references/bibliography section of the paper — do not use cited works to infer tags.
5. Return ONLY a JSON array of tag strings, exactly as they appear in the library. No explanation.${synonymSection}`;

  const userMessage = `Tag library:\n${libraryTags.join("\n")}\n\n---\n\n${contentParts.join("\n\n")}`;

  const xhr = await new Promise<XMLHttpRequest>((resolve, reject) => {
    const req = new XMLHttpRequest();
    req.open("POST", "https://api.anthropic.com/v1/messages");
    req.setRequestHeader("x-api-key", apiKey);
    req.setRequestHeader("anthropic-version", "2023-06-01");
    req.setRequestHeader("Content-Type", "application/json");
    req.timeout = 60_000;
    req.onload = () => resolve(req);
    req.onerror = () => reject(new Error("Network error"));
    req.ontimeout = () => reject(new Error("Request timed out"));
    req.send(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    );
  }).catch((e: Error) => {
    ztoolkit.log(`[SemanticTagger] Network error calling Claude API: ${e.message}`);
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({ text: `Network error — could not reach Claude API: ${e.message}`, type: "fail" })
      .show()
      .startCloseTimer(8000);
    return null;
  });

  if (!xhr) return { tags: [], inputTokens: 0, outputTokens: 0, apiError: true };

  if (xhr.status !== 200) {
    // Parse Anthropic's error message for a clearer notification
    let apiMessage = `HTTP ${xhr.status}`;
    try {
      const errBody = JSON.parse(xhr.responseText ?? "{}") as { error?: { message?: string } };
      if (errBody?.error?.message) apiMessage += `: ${errBody.error.message}`;
    } catch { /* use raw status only */ }
    ztoolkit.log(`[SemanticTagger] Claude API error — ${apiMessage}\nKey length: ${apiKey.length}`);
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({ text: `Claude API error — ${apiMessage}`, type: "fail" })
      .show()
      .startCloseTimer(10000);
    return { tags: [], inputTokens: 0, outputTokens: 0, apiError: true };
  }

  const data = JSON.parse(xhr.responseText ?? "{}") as Record<string, unknown>;
  const usage = data?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;

  const content = data?.content as Array<{ text?: string }> | undefined;
  const text: string = content?.[0]?.text ?? "";

  try {
    // Extract JSON array from response (may be wrapped in markdown)
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return { tags: [], inputTokens, outputTokens, apiError: false };
    const tags = JSON.parse(match[0]) as string[];
    return { tags, inputTokens, outputTokens, apiError: false };
  } catch {
    ztoolkit.log(`[SemanticTagger] Failed to parse Claude response: ${text}`);
    return { tags: [], inputTokens, outputTokens, apiError: false };
  }
}
