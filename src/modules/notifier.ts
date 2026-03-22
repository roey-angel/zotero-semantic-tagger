import { config } from "../../package.json";
import { tagItem } from "./tagger";

const PREFS = config.prefsPrefix;
const FIND_FULL_TEXT_WAIT_MS = 30_000;

let notifierID: string | null = null;

// Maps item ID → pending setTimeout timer ID.
// When a new item is added, we wait up to 30s for a PDF to arrive (Find Full Text).
// If a PDF attachment is added first, we cancel the timer and tag immediately with the PDF.
// If no PDF arrives, the timer fires and we tag with title + abstract only.
const _pendingTags = new Map<number, number>();

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

        const win = Zotero.getMainWindow();

        for (const id of ids) {
          const item = Zotero.Items.get(id as number);
          if (!item) continue;

          if (item.isRegularItem()) {
            // Schedule a delayed tag to allow Find Full Text to run first.
            // If a PDF attachment arrives before the timer fires, the timer
            // will be cancelled and tagging will happen immediately with the PDF.
            const itemId = id as number;
            const timer = (win ?? globalThis).setTimeout(async () => {
              _pendingTags.delete(itemId);
              const latestItem = Zotero.Items.get(itemId);
              if (latestItem && latestItem.isRegularItem()) {
                await tagItem(latestItem).catch((e) =>
                  ztoolkit.log(`[SemanticTagger] Error tagging item ${itemId}: ${e}`),
                );
              }
            }, FIND_FULL_TEXT_WAIT_MS);
            _pendingTags.set(itemId, timer as number);

          } else if (
            item.isAttachment() &&
            item.attachmentContentType === "application/pdf" &&
            item.parentItemID
          ) {
            // PDF attached to an existing item (Find Full Text, manual attach, etc.).
            // Cancel any pending delayed tag for the parent and tag immediately with PDF.
            const parentId = item.parentItemID;
            const pendingTimer = _pendingTags.get(parentId);
            if (pendingTimer !== undefined) {
              (win ?? globalThis).clearTimeout(pendingTimer);
              _pendingTags.delete(parentId);
            }

            const parent = Zotero.Items.get(parentId);
            if (parent && parent.isRegularItem()) {
              await Zotero.Promise.delay(1000); // let Zotero finish writing the attachment
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
  // Cancel any pending timers on shutdown
  const win = Zotero.getMainWindow();
  for (const timer of _pendingTags.values()) {
    (win ?? globalThis).clearTimeout(timer);
  }
  _pendingTags.clear();
}
