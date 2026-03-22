import { config } from "../../package.json";
import { tagItem } from "./tagger";

const PREFS = config.prefsPrefix;
let notifierID: string | null = null;

export function registerNotifier() {
  notifierID = Zotero.Notifier.registerObserver(
    {
      notify: async (
        event: string,
        type: string,
        ids: Array<string | number>,
        _extraData: Record<string, unknown>,
      ) => {
        if (event !== "add" || type !== "item") return;
        const watcherEnabled = Zotero.Prefs.get(`${PREFS}.watcherEnabled`, true);
        if (!watcherEnabled) return;

        for (const id of ids) {
          const item = Zotero.Items.get(id as number);
          if (!item) continue;

          if (item.isRegularItem()) {
            // New regular item added (import, browser connector, Add by Identifier, etc.)
            await Zotero.Promise.delay(2000);
            await tagItem(item).catch((e) =>
              ztoolkit.log(`[SemanticTagger] Error tagging item ${id}: ${e}`),
            );
          } else if (
            item.isAttachment() &&
            item.attachmentContentType === "application/pdf" &&
            item.parentItemID
          ) {
            // PDF attached to an existing item (e.g. via Find Full Text)
            const parent = Zotero.Items.get(item.parentItemID);
            if (parent && parent.isRegularItem()) {
              await Zotero.Promise.delay(2000);
              await tagItem(parent).catch((e) =>
                ztoolkit.log(
                  `[SemanticTagger] Error tagging parent of attachment ${id}: ${e}`,
                ),
              );
            }
          }
        }
      },
    },
    ["item"],
    "semantic-tagger-notifier",
  );
}

export function unregisterNotifier() {
  if (notifierID) {
    Zotero.Notifier.unregisterObserver(notifierID);
    notifierID = null;
  }
}
