/**
 * Loads and parses a synonym file.
 *
 * File format: one synonym group per line, entries separated by semicolons.
 * Example:
 *   Mats; biocrust; biological soil crust; cryptogam; biofilm
 *   CH4; methane; natural gas
 *
 * Returns an array of synonym groups (each group is an array of lowercase strings).
 */
export async function loadSynonyms(filePath: string): Promise<string[][]> {
  try {
    const text = await IOUtils.readUTF8(filePath);
    return parseSynonymText(text);
  } catch (e) {
    ztoolkit.log(`[SemanticTagger] Could not load synonyms from ${filePath}: ${e}`);
    return [];
  }
}

export function parseSynonymText(text: string): string[][] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) =>
      line
        .split(";")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    )
    .filter((group) => group.length > 0);
}
