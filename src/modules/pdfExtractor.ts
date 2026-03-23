let _cachedScriptPath: string | null = null;

export interface PdfExtractionResult {
  text: string | null;
  warning: string | null;
}

/**
 * Tries to get PDF text from Zotero's own full-text search cache
 * (.zotero-ft-cache), which Zotero creates automatically when indexing.
 * This requires no Python and works on all platforms.
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
    ztoolkit.log(`[SemanticTagger] Checking Zotero cache: ${cachePath}`);
    const text = await IOUtils.readUTF8(cachePath).catch((e) => {
      ztoolkit.log(`[SemanticTagger] Cache not readable: ${e}`);
      return null;
    });
    if (text?.trim()) {
      ztoolkit.log(`[SemanticTagger] PDF text from Zotero cache: ${text.length} chars`);
      return text.trim();
    }
    ztoolkit.log(`[SemanticTagger] Cache empty or missing at: ${cachePath}`);
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
  if (_cachedScriptPath) return _cachedScriptPath;

  const destDir = PathUtils.join(Zotero.DataDirectory.dir, "semantic-tagger");
  const destPath = PathUtils.join(destDir, "extract_pdf.py");

  try {
    await IOUtils.makeDirectory(destDir, { ignoreExisting: true });
    const scriptContent = await Zotero.File.getContentsAsync(
      rootURI + "content/extract_pdf.py",
    ) as string;
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
    const exitValue = await Zotero.Utilities.Internal.exec(pythonPath, [
      scriptPath,
      pdfPath,
      tmpPath,
    ]);

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
