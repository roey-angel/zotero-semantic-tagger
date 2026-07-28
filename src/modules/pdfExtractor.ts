let _cachedScriptPath: string | null = null;

export interface PdfExtractionResult {
  text: string | null;
  warning: string | null;
}

/**
 * Tries to get PDF text from Zotero's own full-text cache (.zotero-ft-cache),
 * which Zotero writes when it indexes an attachment. No Python needed, works
 * on all platforms — but only once Zotero has actually indexed the file, so a
 * freshly imported PDF usually misses here.
 *
 * Looks in the attachment's storage directory first (where Zotero puts it),
 * then alongside the file itself.
 */
export async function getPdfTextFromZoteroCache(
  item: Zotero.Item,
): Promise<string | null> {
  for (const id of item.getAttachments()) {
    const attachment = Zotero.Items.get(id);
    if (attachment?.attachmentContentType !== "application/pdf") continue;

    const candidates: string[] = [];
    if (attachment.key) {
      candidates.push(
        PathUtils.join(
          Zotero.DataDirectory.dir,
          "storage",
          attachment.key,
          ".zotero-ft-cache",
        ),
      );
    }
    const pdfPath = await attachment.getFilePathAsync().catch(() => null);
    if (pdfPath) {
      const dir = PathUtils.parent(pdfPath);
      if (dir) candidates.push(PathUtils.join(dir, ".zotero-ft-cache"));
    }

    for (const cachePath of candidates) {
      const text = await IOUtils.readUTF8(cachePath).catch(() => null);
      if (text?.trim()) {
        ztoolkit.log(
          `[SemanticTagger] PDF text from ${cachePath}: ${text.length} chars`,
        );
        return text.trim();
      }
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
export async function resolvePythonScript(
  customScriptPath: string,
): Promise<string> {
  if (customScriptPath) return customScriptPath;
  if (_cachedScriptPath) {
    // Re-extract if previously cached file was corrupted (bug: getContentsAsync returned XHR object)
    const head = await IOUtils.readUTF8(_cachedScriptPath)
      .catch(() => "")
      .then((t) => t.slice(0, 20));
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
    ztoolkit.log(
      `[SemanticTagger] Bundled Python script extracted to: ${destPath}`,
    );
    return destPath;
  } catch (e) {
    ztoolkit.log(
      `[SemanticTagger] Failed to extract bundled Python script: ${e}`,
    );
    return "";
  }
}

const PDF_WARN =
  "PDF text extraction failed — check Python path in Settings → Semantic Tagger (tagging from title + abstract only)";

/**
 * Extracts raw text from a PDF file by invoking the Python helper script.
 * Falls back gracefully if Python or PyMuPDF is unavailable.
 */
export async function extractPdfText(
  pdfPath: string,
  pythonPath: string,
  scriptPath: string,
): Promise<PdfExtractionResult> {
  // Random suffix: avoids predictable temp names in a shared temp dir
  const tmpPath = PathUtils.join(
    PathUtils.tempDir,
    `zst-pdf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`,
  );
  const errPath = tmpPath + ".err";

  ztoolkit.log(
    `[SemanticTagger] PDF extraction (Python): python="${pythonPath}" script="${scriptPath}" pdf="${pdfPath}"`,
  );

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
    const shellCmd = `LD_LIBRARY_PATH=${q(condaLibPath)}:"$LD_LIBRARY_PATH" ${q(pythonPath)} ${q(scriptPath)} ${q(pdfPath)} ${q(tmpPath)} 2>${q(errPath)}`;
    const exitValue = await Zotero.Utilities.Internal.exec("/bin/bash", [
      "-c",
      shellCmd,
    ]);

    ztoolkit.log(
      `[SemanticTagger] PDF extraction exec returned: ${JSON.stringify(exitValue)}`,
    );

    const text = await IOUtils.readUTF8(tmpPath).catch((e) => {
      ztoolkit.log(
        `[SemanticTagger] PDF extraction: failed to read output file: ${e}`,
      );
      return null;
    });
    if (!text?.trim()) {
      const stderr = await IOUtils.readUTF8(errPath).catch(() => "");
      ztoolkit.log(
        `[SemanticTagger] PDF extraction: empty output. Python stderr: ${stderr || "(none)"}`,
      );
      return { text: null, warning: PDF_WARN };
    }
    ztoolkit.log(
      `[SemanticTagger] PDF extraction success: ${text.length} chars`,
    );
    return { text: text.trim(), warning: null };
  } catch (e) {
    const stderr = await IOUtils.readUTF8(errPath).catch(() => "");
    ztoolkit.log(
      `[SemanticTagger] PDF extraction exception: ${e}. Python stderr: ${stderr || "(none)"}`,
    );
    return { text: null, warning: PDF_WARN };
  } finally {
    IOUtils.remove(tmpPath).catch(() => {});
    IOUtils.remove(errPath).catch(() => {});
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
