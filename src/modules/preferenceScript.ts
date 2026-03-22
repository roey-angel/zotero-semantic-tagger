import { config } from "../../package.json";

const PREFS = config.prefsPrefix;
const REF = config.addonRef;

export async function registerPrefsScripts(_window: Window) {
  bindPrefEvents(_window);
}

async function pickFile(win: Window, title: string): Promise<string | null> {
  const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
  // browsingContext is required in newer Gecko
  fp.init((win as any).browsingContext ?? win, title, Ci.nsIFilePicker.modeOpen);
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

  // Browse button for synonym file
  doc.querySelector(`#${REF}-synonyms-browse`)?.addEventListener("click", async () => {
    const path = await pickFile(win, "Select synonym file");
    if (path) {
      Zotero.Prefs.set(`${PREFS}.synonymFile`, path, true);
      const input = doc.querySelector(`#${REF}-synonyms-path`) as HTMLInputElement | null;
      if (input) input.value = path;
    }
  });

  // Browse button for extract_pdf.py script
  doc.querySelector(`#${REF}-script-browse`)?.addEventListener("click", async () => {
    const path = await pickFile(win, "Select extract_pdf.py script");
    if (path) {
      Zotero.Prefs.set(`${PREFS}.scriptPath`, path, true);
      const input = doc.querySelector(`#${REF}-script-path`) as HTMLInputElement | null;
      if (input) input.value = path;
    }
  });
}
