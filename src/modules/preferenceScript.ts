import { config } from "../../package.json";

const PREFS = config.prefsPrefix;
const REF = config.addonRef;

// html:input elements are NOT auto-bound by Zotero's preference system —
// only XUL elements (checkbox, textbox, menulist) are. We must load and save
// all html:input values explicitly.

export async function registerPrefsScripts(_window: Window) {
  loadPrefs(_window);
  bindPrefEvents(_window);
  void loadModels(_window);
}

/**
 * Populates the model dropdown. If an API key is set, the list is fetched
 * from the Models API (exactly the models the key can access); otherwise a
 * small static fallback is shown. The currently selected model is always
 * kept in the list.
 */
async function loadModels(win: Window) {
  const doc = win.document;
  // XUL menulist — html:select popups don't open inside Zotero pref panes
  const sel = doc.getElementById(`zotero-prefpane-${REF}-model`) as any;
  const popup = sel?.querySelector("menupopup");
  if (!sel || !popup) return;

  const current =
    ((Zotero.Prefs.get(`${PREFS}.model`, true) as string) || "").trim() ||
    "claude-sonnet-5";
  const apiKey = (
    (Zotero.Prefs.get(`${PREFS}.apiKey`, true) as string) || ""
  ).trim();

  // Fallback when there is no key yet or the Models API is unreachable
  let models: { id: string; label: string }[] = [
    { id: "claude-sonnet-5", label: "Claude Sonnet 5 (recommended)" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (cheapest)" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
  ];

  if (apiKey) {
    try {
      const resp = await fetch(
        "https://api.anthropic.com/v1/models?limit=100",
        {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
        },
      );
      if (resp.ok) {
        const data = (await resp.json()) as {
          data?: { id: string; display_name?: string }[];
        };
        if (data.data?.length) {
          models = data.data.map((m) => ({
            id: m.id,
            label: m.display_name ? `${m.display_name} (${m.id})` : m.id,
          }));
        }
      } else {
        ztoolkit.log(`[SemanticTagger] Models API HTTP ${resp.status}`);
      }
    } catch (e) {
      ztoolkit.log(`[SemanticTagger] Models API unreachable: ${e}`);
    }
  }

  if (!models.some((m) => m.id === current)) {
    models.unshift({ id: current, label: current });
  }

  popup.textContent = "";
  for (const m of models) {
    const item = (doc as any).createXULElement("menuitem");
    item.setAttribute("label", m.label);
    item.setAttribute("value", m.id);
    popup.appendChild(item);
  }
  sel.value = current;
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

  // API key — a new key may unlock different models, so refresh the dropdown
  doc
    .getElementById(`zotero-prefpane-${REF}-apikey`)
    ?.addEventListener("change", (e: Event) => {
      Zotero.Prefs.set(
        `${PREFS}.apiKey`,
        (e.target as HTMLInputElement).value,
        true,
      );
      void loadModels(win);
    });

  // Model dropdown (XUL menulist fires "command", not "change")
  const modelSel = doc.getElementById(`zotero-prefpane-${REF}-model`) as any;
  modelSel?.addEventListener("command", () => {
    const v = modelSel.value as string;
    if (v) Zotero.Prefs.set(`${PREFS}.model`, v, true);
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
