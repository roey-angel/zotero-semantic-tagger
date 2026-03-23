import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { registerNotifier, unregisterNotifier } from "./modules/notifier";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { tagItem } from "./modules/tagger";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  registerNotifier();

  await Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: "Semantic Tagger",
    image: `${rootURI}content/icons/favicon@0.5x.png`,
  });

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // Register right-click menu item for manual batch tagging
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: "semantic-tagger-tag-selected",
    label: getString("menuitem-tag-selected"),
    icon: `${rootURI}content/icons/favicon@0.5x.png`,
    commandListener: (_ev) => {
      addon.hooks.onMenuTagSelected();
    },
  });
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  unregisterNotifier();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  ztoolkit.log("notify", event, type, ids, extraData);
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

async function onMenuTagSelected() {
  const items = Zotero.getActiveZoteroPane().getSelectedItems();
  if (!items || items.length === 0) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({ text: getString("notice-no-items-selected"), type: "fail" })
      .show()
      .startCloseTimer(3000);
    return;
  }

  const progressWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: false,
  })
    .createLine({
      text: getString("notice-tagging-start", { args: { count: items.length } }),
      type: "default",
      progress: 0,
    })
    .show();

  let done = 0;
  for (const item of items) {
    await tagItem(item).catch((e) =>
      ztoolkit.log(`[SemanticTagger] Batch tag error for item ${item.id}: ${e}`),
    );
    done++;
    progressWin.changeLine({
      progress: Math.round((done / items.length) * 100),
      text: `${done}/${items.length} ${getString("notice-tagging-progress")}`,
    });
  }

  progressWin.changeLine({
    progress: 100,
    text: getString("notice-tagging-done"),
    type: "success",
  });
  progressWin.startCloseTimer(4000);
}

function onShortcuts(_type: string) {
  // No shortcuts defined yet
}

function onDialogEvents(_type: string) {
  // No dialogs defined yet
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
  onMenuTagSelected,
};
