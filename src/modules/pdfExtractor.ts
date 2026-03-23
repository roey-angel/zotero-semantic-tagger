let _cachedScriptPath: string | null = null;

export interface PdfExtractionResult {
  text: string | null;
  warning: string | null;
}

/**
 * Tries to get PDF text from Zotero's fulltext search database (fulltext.sqlite).
 * Zotero stores indexed PDF content in its own database, independently of where
 * the PDF file is stored — so this works with ZotMoov and other file-moving tools.
 *
 * Tries several API variants because the exact surface differs across Zotero builds.
 */
export async function getPdfTextFromFulltextDB(
  item: Zotero.Item,
): Promise<string | null> {
  const attachmentIDs = item.getAttachments();
  for (const id of attachmentIDs) {
    const attachment = Zotero.Items.get(id);
    if (attachment?.attachmentContentType !== "application/pdf") continue;

    const ft = Zotero.Fulltext as any;

    // Variant A: private _fulltextDB connection (Zotero 7 internal name)
    for (const prop of ["_fulltextDB", "_db", "db"]) {
      try {
        const db = ft[prop];
        if (!db) continue;
        const content = await db.valueQueryAsync(
          "SELECT content FROM content WHERE itemID=?", [id],
        ) as string | null | undefined;
        if (content?.trim()) {
          ztoolkit.log(`[SemanticTagger] PDF text from Fulltext.${prop}: ${content.length} chars`);
          return content.trim();
        }
      } catch (e) {
        ztoolkit.log(`[SemanticTagger] Fulltext.${prop} query error: ${e}`);
      }
    }

    // Variant B: fulltext.sqlite is attached to Zotero's main DB as schema "fulltext"
    try {
      const content = await Zotero.DB.valueQueryAsync(
        "SELECT content FROM fulltext.content WHERE itemID=?", [id],
      ) as string | null | undefined;
      if (content?.trim()) {
        ztoolkit.log(`[SemanticTagger] PDF text from Zotero.DB attached fulltext: ${content.length} chars`);
        return content.trim();
      }
    } catch (_e) {
      // not attached — silently skip
    }

    // Variant C: .zotero-ft-cache in Zotero's storage dir for this attachment key
    try {
      const key = attachment?.key;
      if (key) {
        const cachePath = PathUtils.join(Zotero.DataDirectory.dir, "storage", key, ".zotero-ft-cache");
        const text = await IOUtils.readUTF8(cachePath).catch(() => null);
        if (text?.trim()) {
          ztoolkit.log(`[SemanticTagger] PDF text from storage cache (key ${key}): ${text.length} chars`);
          return text.trim();
        }
      }
    } catch (_e) {
      // silently continue
    }
  }
  return null;
}

/**
 * Tries to get PDF text from Zotero's own full-text search cache
 * (.zotero-ft-cache), which Zotero creates automatically when indexing.
 * This requires no Python and works on all platforms, but only for items
 * stored in Zotero's default storage directory (not with ZotMoov).
 */
export async function getPdfTextFromZoteroCache(
  item: Zotero.Item,
): Promise<string | null> {
  const attachmentIDs = item.getAttachments();
  for (const id of attachmentIDs) {
    const attachment = Zotero.Items.get(id);
    if (attachment?.attachmentContentType !== "application/pdf") continue;

    const pdfPath = await attachment.getFilePathAsync();
    if (!pdfPath) continue;

    const storageDir = PathUtils.parent(pdfPath) ?? "";
    const cachePath = PathUtils.join(storageDir, ".zotero-ft-cache");
    const text = await IOUtils.readUTF8(cachePath).catch(() => null);
    if (text?.trim()) {
      ztoolkit.log(`[SemanticTagger] PDF text from .zotero-ft-cache: ${text.length} chars`);
      return text.trim();
    }
  }
  return null;
}

/**
 * Returns the path to extract_pdf.py to use for PDF extraction.
 *
 * If the user has configured a custom script path in preferences, that is
 * used. Otherwise, the bundled script is copied from the XPI to the Zotero
 * data directory on first call and that path is returned.
 */
export async function resolvePythonScript(customScriptPath: string): Promise<string> {
  if (customScriptPath) return customScriptPath;
  if (_cachedScriptPath) {
    // Re-extract if previously cached file was corrupted (bug: getContentsAsync returned XHR object)
    const head = await IOUtils.readUTF8(_cachedScriptPath).catch(() => "").then(t => t.slice(0, 20));
    if (!head.startsWith("[object")) return _cachedScriptPath;
    _cachedScriptPath = null; // force re-extraction
  }

  const destDir = PathUtils.join(Zotero.DataDirectory.dir, "semantic-tagger");
  const destPath = PathUtils.join(destDir, "extract_pdf.py");

  try {
    await IOUtils.makeDirectory(destDir, { ignoreExisting: true });
    // Use fetch() — Zotero.File.getContentsAsync resolves with [object XMLHttpRequest]
    // when loading moz-extension:// resources, which corrupts the written file.
    const resp = await fetch(rootURI + "content/extract_pdf.py");
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    const scriptContent = await resp.text();
    await IOUtils.writeUTF8(destPath, scriptContent);
    _cachedScriptPath = destPath;
    ztoolkit.log(`[SemanticTagger] Bundled Python script extracted to: ${destPath}`);
    return destPath;
  } catch (e) {
    ztoolkit.log(`[SemanticTagger] Failed to extract bundled Python script: ${e}`);
    return "";
  }
}

const PDF_WARN =
  "PDF found but could not extract text (Python/PyMuPDF not available) — tagged from title + abstract only";

/**
 * Extracts raw text from a PDF file by invoking the Python helper script.
 * Falls back gracefully if Python or PyMuPDF is unavailable.
 */
export async function extractPdfText(
  pdfPath: string,
  pythonPath: string,
  scriptPath: string,
): Promise<PdfExtractionResult> {
  const tmpPath = PathUtils.join(
    PathUtils.tempDir,
    `zst-pdf-${Date.now()}.txt`,
  );

  ztoolkit.log(`[SemanticTagger] PDF extraction (Python): python="${pythonPath}" script="${scriptPath}" pdf="${pdfPath}"`);

  try {
    // Run via bash so that Python environments that need LD_LIBRARY_PATH
    // (e.g. conda/miniforge, some virtualenv setups) can find their shared
    // libraries. When Zotero spawns a process directly, these env vars are not
    // inherited. The inline assignment prepends <prefix>/lib when pythonPath
    // is inside a standard bin/ directory. On Windows this exec throws (no
    // /bin/bash), which is caught below and returns PDF_WARN gracefully; the
    // Zotero fulltext DB and cache-file approaches still work on Windows.
    const condaLibPath = pythonPath.replace(/\/bin\/python[0-9.]*$/, "/lib");
    const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const shellCmd = `LD_LIBRARY_PATH=${q(condaLibPath)}:"$LD_LIBRARY_PATH" ${q(pythonPath)} ${q(scriptPath)} ${q(pdfPath)} ${q(tmpPath)}`;
    const exitValue = await Zotero.Utilities.Internal.exec("/bin/bash", ["-c", shellCmd]);

    ztoolkit.log(`[SemanticTagger] PDF extraction exec returned: ${JSON.stringify(exitValue)}`);

    const text = await IOUtils.readUTF8(tmpPath).catch((e) => {
      ztoolkit.log(`[SemanticTagger] PDF extraction: failed to read tmpPath: ${e}`);
      return null;
    });
    if (!text?.trim()) {
      ztoolkit.log(`[SemanticTagger] PDF extraction: tmpPath empty or missing`);
      return { text: null, warning: PDF_WARN };
    }
    ztoolkit.log(`[SemanticTagger] PDF extraction success: ${text.length} chars`);
    return { text: text.trim(), warning: null };
  } catch (e) {
    ztoolkit.log(`[SemanticTagger] PDF extraction exception: ${e}`);
    return { text: null, warning: PDF_WARN };
  } finally {
    IOUtils.remove(tmpPath).catch(() => {});
  }
}

/**
 * Retrieves the file path of the first PDF attachment for a Zotero item.
 * Returns null if no PDF attachment is found or the file doesn't exist on disk.
 */
export async function getPdfPath(item: Zotero.Item): Promise<string | null> {
  const attachmentIDs = item.getAttachments();
  for (const id of attachmentIDs) {
    const attachment = Zotero.Items.get(id);
    if (attachment?.attachmentContentType === "application/pdf") {
      const path = await attachment.getFilePathAsync();
      if (path) return path;
    }
  }
  return null;
}
