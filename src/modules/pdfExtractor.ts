let _cachedScriptPath: string | null = null;

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
    return destPath;
  } catch (e) {
    ztoolkit.log(`[SemanticTagger] Failed to extract bundled Python script: ${e}`);
    return "";
  }
}

export interface PdfExtractionResult {
  text: string | null;
  warning: string | null;
}

const PDF_WARN =
  "PDF extraction failed — make sure Python and PyMuPDF are installed (pip install PyMuPDF)";

/**
 * Extracts raw text from a PDF file by invoking the Python helper script.
 *
 * The plugin passes a temp file path to the Python script as the second
 * argument. The script writes extracted text there; the plugin reads it back.
 *
 * Requires:
 *   - Python 3 installed and accessible at the configured path
 *   - PyMuPDF installed: pip install PyMuPDF
 *
 * Returns { text, warning }. Warning is non-null when extraction failed.
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

  try {
    const result = await Zotero.Utilities.Internal.exec(pythonPath, [
      scriptPath,
      pdfPath,
      tmpPath,
    ]);

    if (result instanceof Error) {
      ztoolkit.log(`[SemanticTagger] PDF extraction error: ${result.message}`);
      return { text: null, warning: PDF_WARN };
    }

    const text = await IOUtils.readUTF8(tmpPath).catch(() => null);
    if (!text?.trim()) {
      return { text: null, warning: PDF_WARN };
    }
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
