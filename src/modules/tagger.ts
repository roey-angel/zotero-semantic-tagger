import { config } from "../../package.json";
import {
  extractPdfText,
  getPdfPath,
  getPdfTextFromFulltextDB,
  getPdfTextFromZoteroCache,
  resolvePythonScript,
} from "./pdfExtractor";
import { loadSynonyms } from "./synonyms";

let _sessionTokens = 0;
let _sessionPaused = false;
let _tokenWarningsGiven = 0; // warns at N, 2N, 3N… tokens

const PREFS = config.prefsPrefix;

/**
 * Lifts a session pause (token budget declined or credits exhausted).
 * Called when the user explicitly starts a manual batch tag.
 */
export function resumeSession(): void {
  _sessionPaused = false;
}

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
      .createLine({
        text: "Tagging paused (session token budget reached)",
        type: "default",
      })
      .show()
      .startCloseTimer(4000);
    return;
  }

  const apiKey = Zotero.Prefs.get(`${PREFS}.apiKey`, true) as string;
  if (!apiKey) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: "No API key set — open Settings → Semantic Tagger",
        type: "fail",
      })
      .show()
      .startCloseTimer(6000);
    return;
  }

  const strictness =
    (Zotero.Prefs.get(`${PREFS}.strictness`, true) as number) ?? 50;
  const model = (
    (Zotero.Prefs.get(`${PREFS}.model`, true) as string) || "claude-sonnet-5"
  ).trim();
  const synonymFilePath = Zotero.Prefs.get(
    `${PREFS}.synonymFile`,
    true,
  ) as string;
  const usePdf = Zotero.Prefs.get(`${PREFS}.usePdf`, true) as boolean;
  const pythonPath = (
    (Zotero.Prefs.get(`${PREFS}.pythonPath`, true) as string) || "python3"
  ).trim();
  const scriptPath = (
    (Zotero.Prefs.get(`${PREFS}.scriptPath`, true) as string) || ""
  ).trim();

  const title = item.getField("title") as string;
  const abstract = item.getField("abstractNote") as string;

  // Collect PDF text unless the user has opted out.
  // Order: Zotero fulltext DB → .zotero-ft-cache file → Python/PyMuPDF.
  let pdfText: string | null = null;

  if (usePdf) {
    pdfText = await getPdfTextFromFulltextDB(item);

    if (!pdfText) {
      pdfText = await getPdfTextFromZoteroCache(item);
    }

    if (!pdfText) {
      const resolvedScriptPath = await resolvePythonScript(scriptPath);
      if (resolvedScriptPath) {
        const pdfPath = await getPdfPath(item);
        if (pdfPath) {
          const result = await extractPdfText(
            pdfPath,
            pythonPath,
            resolvedScriptPath,
          );
          pdfText = result.text;
          if (result.warning) {
            new ztoolkit.ProgressWindow(addon.data.config.addonName)
              .createLine({ text: result.warning, type: "default" })
              .show()
              .startCloseTimer(8000);
          }
        } else {
          new ztoolkit.ProgressWindow(addon.data.config.addonName)
            .createLine({
              text: "No PDF attached — tagging from title + abstract only",
              type: "default",
            })
            .show()
            .startCloseTimer(5000);
        }
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
      .createLine({
        text: "No tags in library — add tags to Zotero first",
        type: "fail",
      })
      .show()
      .startCloseTimer(6000);
    return;
  }

  const synonymGroups = synonymFilePath
    ? await loadSynonyms(synonymFilePath)
    : [];

  const {
    tags: matchedTags,
    inputTokens,
    outputTokens,
    apiError,
  } = await queryClaudeForTags({
    apiKey: apiKey.trim(),
    model,
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
  const tokenWarnThreshold =
    (Zotero.Prefs.get(`${PREFS}.tokenWarnThreshold`, true) as number) ?? 20_000;
  if (
    tokenWarnThreshold > 0 &&
    _sessionTokens >= (_tokenWarningsGiven + 1) * tokenWarnThreshold
  ) {
    _tokenWarningsGiven++;
    const win = Zotero.getMainWindow();
    const cont = win?.confirm(
      `Semantic Tagger has used ${_sessionTokens.toLocaleString()} tokens this session.\n\nContinue tagging? (Next warning after another ${tokenWarnThreshold.toLocaleString()} tokens)`,
    );
    if (!cont) {
      _sessionPaused = true;
    }
  }

  if (matchedTags.length === 0) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: "No matching tags found in your library",
        type: "default",
      })
      .show()
      .startCloseTimer(4000);
    return;
  }

  // Apply matched tags (only from existing library, non-destructively)
  const libraryTagSet = new Set(libraryTags.map((t) => t.toLowerCase()));
  const applied: string[] = [];
  for (const tag of matchedTags) {
    if (libraryTagSet.has(tag.toLowerCase())) {
      item.addTag(tag);
      applied.push(tag);
    }
  }

  if (applied.length > 0) {
    await item.saveTx();
    ztoolkit.log(
      `[SemanticTagger] Item ${item.id}: applied ${applied.length} tag(s): ${applied.join(", ")}`,
    );
  }
}

interface ClaudeTagQuery {
  apiKey: string;
  model: string;
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

async function queryClaudeForTags(
  query: ClaudeTagQuery,
): Promise<ClaudeTagResult> {
  const {
    apiKey,
    model,
    title,
    abstract,
    pdfText,
    libraryTags,
    synonymGroups,
    strictness,
  } = query;

  const [tagMin, tagMax, strictnessInstruction] =
    strictness > 66
      ? [
          2,
          4,
          "Be very strict: select AT MOST 4 tags (ideally 2–3). Only apply a tag if it describes a central research topic of the paper — something the paper directly investigates, develops, or makes a primary contribution to. If unsure, leave it out.",
        ]
      : strictness > 33
        ? [
            4,
            7,
            "Be moderate: select 4–7 tags. Apply a tag if the paper substantially discusses or relies on the concept, even if it is not the primary focus.",
          ]
        : [
            6,
            12,
            "Be broad: select 6–12 tags. Apply a tag if the paper meaningfully mentions, uses, or engages with the concept — even in passing, as background, or in the methods section.",
          ];

  const synonymSection =
    synonymGroups.length > 0
      ? `\nSynonym groups (treat all entries in a group as equivalent):\n${synonymGroups
          .map((g) => g.join("; "))
          .join("\n")}`
      : "";

  const contentParts: string[] = [];
  if (title) contentParts.push(`Title: ${title}`);
  if (abstract) contentParts.push(`Abstract: ${abstract}`);
  if (pdfText)
    contentParts.push(`PDF text (excerpt):\n${pdfText.slice(0, 4000)}`);

  const systemPrompt = `You are a scientific literature tagger. Your task is to select tags from a provided library that best describe a given paper.

RULES:
1. You may ONLY use tags from the provided library — never invent new tags.
2. Select between ${tagMin} and ${tagMax} tags. Stay within this range — it is set by the user's strictness preference.
3. ${strictnessInstruction}
4. Ignore the references/bibliography section of the paper — do not use cited works to infer tags.
5. Return ONLY a JSON array of tag strings, exactly as they appear in the library. No explanation.${synonymSection}`;

  // The tag library is identical across all calls in a session, so mark it for
  // prompt caching (GA — no beta header needed). Anthropic caches it after the
  // first call (~90% cheaper on cache hits).
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
        model,
        max_tokens: 512,
        // Tag selection is a simple classification task: thinking off + low
        // effort is the documented cheap/fast configuration for it.
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Tag library:\n${libraryTags.join("\n")}`,
                cache_control: { type: "ephemeral" },
              },
              {
                type: "text",
                text: `---\n\n${contentParts.join("\n\n")}`,
              },
            ],
          },
        ],
      }),
    );
  }).catch((e: Error) => {
    ztoolkit.log(
      `[SemanticTagger] Network error calling Claude API: ${e.message}`,
    );
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: `Network error — could not reach Claude API: ${e.message}`,
        type: "fail",
      })
      .show()
      .startCloseTimer(8000);
    return null;
  });

  if (!xhr)
    return { tags: [], inputTokens: 0, outputTokens: 0, apiError: true };

  if (xhr.status !== 200) {
    let apiMessage = `HTTP ${xhr.status}`;
    let isOutOfCredits = false;
    try {
      const errBody = JSON.parse(xhr.responseText ?? "{}") as {
        error?: { message?: string; type?: string };
      };
      if (errBody?.error?.message) apiMessage += `: ${errBody.error.message}`;
      isOutOfCredits =
        xhr.status === 402 ||
        (errBody?.error?.message ?? "").toLowerCase().includes("credit");
    } catch {
      /* use raw status only */
    }
    ztoolkit.log(
      `[SemanticTagger] Claude API error — ${apiMessage}\nKey length: ${apiKey.length}`,
    );
    const text = isOutOfCredits
      ? "Anthropic API credits exhausted — please top up at console.anthropic.com. Tagging paused."
      : `Claude API error — ${apiMessage}`;
    if (isOutOfCredits) _sessionPaused = true;
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({ text, type: "fail" })
      .show()
      .startCloseTimer(isOutOfCredits ? 30000 : 10000);
    return { tags: [], inputTokens: 0, outputTokens: 0, apiError: true };
  }

  const data = JSON.parse(xhr.responseText ?? "{}") as Record<string, unknown>;
  const usage = data?.usage as
    | { input_tokens?: number; output_tokens?: number }
    | undefined;
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;

  // Find the text block rather than assuming content[0] — some models prepend
  // a thinking block to the response.
  const content = data?.content as
    | Array<{ type?: string; text?: string }>
    | undefined;
  const text: string =
    content?.find((b) => b?.type === "text" && b.text)?.text ?? "";

  try {
    // Extract JSON array from response (may be wrapped in markdown)
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return { tags: [], inputTokens, outputTokens, apiError: false };
    // Model output is untrusted: keep only strings
    const parsed = JSON.parse(match[0]) as unknown;
    const tags = Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : [];
    return { tags, inputTokens, outputTokens, apiError: false };
  } catch {
    ztoolkit.log(`[SemanticTagger] Failed to parse Claude response: ${text}`);
    return { tags: [], inputTokens, outputTokens, apiError: false };
  }
}
