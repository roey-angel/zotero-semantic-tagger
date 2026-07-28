import { config } from "../../package.json";

const PREFS = config.prefsPrefix;
const REF = config.addonRef;

// html:input elements are NOT auto-bound by Zotero's preference system —
// only XUL elements (checkbox, textbox, menulist) are. We must load and save
// all html:input values explicitly.

export async function registerPrefsScripts(_window: Window) {
  loadPrefs(_window);
  bindPrefEvents(_window);
}

function loadPrefs(win: Window) {
  const doc = win.document;

  setInput(
    doc,
    `zotero-prefpane-${REF}-apikey`,
    (Zotero.Prefs.get(`${PREFS}.apiKey`, true) as string) ?? "",
  );
  setInput(
    doc,
    `zotero-prefpane-${REF}-strictness`,
    String(Zotero.Prefs.get(`${PREFS}.strictness`, true) ?? 50),
  );
  setInput(
    doc,
    `${REF}-synonyms-path`,
    (Zotero.Prefs.get(`${PREFS}.synonymFile`, true) as string) ?? "",
  );
  setInput(
    doc,
    `zotero-prefpane-${REF}-python`,
    (Zotero.Prefs.get(`${PREFS}.pythonPath`, true) as string) ?? "",
  );
  setInput(
    doc,
    `${REF}-script-path`,
    (Zotero.Prefs.get(`${PREFS}.scriptPath`, true) as string) ?? "",
  );
  setInput(
    doc,
    `zotero-prefpane-${REF}-token-warn`,
    String(Zotero.Prefs.get(`${PREFS}.tokenWarnThreshold`, true) ?? 20000),
  );
}

function setInput(doc: Document, id: string, value: string) {
  const el = doc.getElementById(id) as HTMLInputElement | null;
  if (el) el.value = value;
}

async function pickFile(win: Window, title: string): Promise<string | null> {
  const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
  fp.init(
    (win as any).browsingContext ?? win,
    title,
    Ci.nsIFilePicker.modeOpen,
  );
  fp.appendFilters(Ci.nsIFilePicker.filterAll!);
  const rv: number = await new Promise((resolve) =>
    fp.open((result: number | undefined) => resolve(result ?? -1)),
  );
  if (rv === Ci.nsIFilePicker.returnOK) {
    return fp.file?.path ?? null;
  }
  return null;
}

function bindPrefEvents(win: Window) {
  const doc = win.document;

  // API key
  doc
    .getElementById(`zotero-prefpane-${REF}-apikey`)
    ?.addEventListener("change", (e: Event) => {
      Zotero.Prefs.set(
        `${PREFS}.apiKey`,
        (e.target as HTMLInputElement).value,
        true,
      );
    });

  // Strictness slider
  doc
    .getElementById(`zotero-prefpane-${REF}-strictness`)
    ?.addEventListener("change", (e: Event) => {
      const v = parseInt((e.target as HTMLInputElement).value, 10);
      if (!Number.isNaN(v)) Zotero.Prefs.set(`${PREFS}.strictness`, v, true);
    });

  // Token warning threshold (html:input — not auto-bound by Zotero)
  doc
    .getElementById(`zotero-prefpane-${REF}-token-warn`)
    ?.addEventListener("change", (e: Event) => {
      const v = parseInt((e.target as HTMLInputElement).value, 10);
      if (!Number.isNaN(v) && v >= 0)
        Zotero.Prefs.set(`${PREFS}.tokenWarnThreshold`, v, true);
    });

  // Python path
  doc
    .getElementById(`zotero-prefpane-${REF}-python`)
    ?.addEventListener("change", (e: Event) => {
      Zotero.Prefs.set(
        `${PREFS}.pythonPath`,
        (e.target as HTMLInputElement).value,
        true,
      );
    });

  // Browse button for synonym file
  doc
    .querySelector(`#${REF}-synonyms-browse`)
    ?.addEventListener("click", async () => {
      const path = await pickFile(win, "Select synonym file");
      if (path) {
        Zotero.Prefs.set(`${PREFS}.synonymFile`, path, true);
        setInput(doc, `${REF}-synonyms-path`, path);
      }
    });

  // Synonym path (typed directly)
  doc
    .getElementById(`${REF}-synonyms-path`)
    ?.addEventListener("change", (e: Event) => {
      Zotero.Prefs.set(
        `${PREFS}.synonymFile`,
        (e.target as HTMLInputElement).value,
        true,
      );
    });

  // Browse button for extract_pdf.py script
  doc
    .querySelector(`#${REF}-script-browse`)
    ?.addEventListener("click", async () => {
      const path = await pickFile(win, "Select extract_pdf.py script");
      if (path) {
        Zotero.Prefs.set(`${PREFS}.scriptPath`, path, true);
        setInput(doc, `${REF}-script-path`, path);
      }
    });

  // Script path (typed directly)
  doc
    .getElementById(`${REF}-script-path`)
    ?.addEventListener("change", (e: Event) => {
      Zotero.Prefs.set(
        `${PREFS}.scriptPath`,
        (e.target as HTMLInputElement).value,
        true,
      );
    });
}
