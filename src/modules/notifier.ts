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

// Parent IDs that have already been tagged via the PDF-attachment path.
// Prevents a duplicate tag run when the PDF attachment notification arrives
// before the parent item notification (so no timer was set yet to cancel).
const _recentlyTagged = new Set<number>();

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
        const watcherEnabled = Zotero.Prefs.get(
          `${PREFS}.watcherEnabled`,
          true,
        );
        if (!watcherEnabled) return;

        const win = Zotero.getMainWindow();

        // Two-pass processing: timers must be registered for all regular items
        // before PDF attachments try to cancel them, because Zotero may send
        // [attachment, parent] in a single batch (attachment first).
        const pdfAttachments: Zotero.Item[] = [];

        // Pass 1: schedule timers for regular items.
        for (const id of ids) {
          const item = Zotero.Items.get(id as number);
          if (!item) continue;

          if (item.isRegularItem()) {
            const itemId = id as number;
            // Skip if this parent was already tagged by an earlier PDF-attachment
            // notification (can happen when attachment arrives before parent).
            if (_recentlyTagged.has(itemId)) {
              _recentlyTagged.delete(itemId);
              continue;
            }
            const timer = (win ?? globalThis).setTimeout(async () => {
              _pendingTags.delete(itemId);
              const latestItem = Zotero.Items.get(itemId);
              if (latestItem && latestItem.isRegularItem()) {
                await tagItem(latestItem).catch((e) =>
                  ztoolkit.log(
                    `[SemanticTagger] Error tagging item ${itemId}: ${e}`,
                  ),
                );
              }
            }, FIND_FULL_TEXT_WAIT_MS);
            _pendingTags.set(itemId, timer as number);
          } else if (
            item.isAttachment() &&
            item.attachmentContentType === "application/pdf" &&
            item.parentItemID
          ) {
            pdfAttachments.push(item);
          }
        }

        // Pass 2: process PDF attachments — cancel the parent's timer and tag immediately.
        for (const item of pdfAttachments) {
          const parentId = item.parentItemID as number;
          const pendingTimer = _pendingTags.get(parentId);
          if (pendingTimer !== undefined) {
            (win ?? globalThis).clearTimeout(pendingTimer);
            _pendingTags.delete(parentId);
          } else {
            // No timer yet — the parent item notification may arrive later.
            // Mark it so we don't schedule a timer when the parent notification fires.
            _recentlyTagged.add(parentId);
            (win ?? globalThis).setTimeout(
              () => _recentlyTagged.delete(parentId),
              FIND_FULL_TEXT_WAIT_MS * 2,
            );
          }

          const parent = Zotero.Items.get(parentId);
          if (parent && parent.isRegularItem()) {
            // File-moving tools (e.g. ZotMoov) relocate the PDF right after
            // import, so the recorded path can be transiently missing. Wait
            // until the file is actually on disk before tagging.
            await waitForPdfFile(parent);
            await tagItem(parent).catch((e) =>
              ztoolkit.log(
                `[SemanticTagger] Error tagging parent of attachment ${item.id}: ${e}`,
              ),
            );
          }
        }
      },
    },
    ["item"],
    "semantic-tagger-notifier",
  );
}

/**
 * Waits until one of the parent's PDF attachments is present on disk at a
 * path that stops changing. File-moving tools (ZotMoov, ZotFile) relocate
 * the PDF out of Zotero storage moments after import and rewrite the
 * attachment as a linked file; extracting during that window opens a path
 * that is deleted mid-read. Requiring the same path twice, 2s apart, means
 * the move has finished.
 *
 * Gives up after timeoutMs and lets tagging proceed with title + abstract.
 */
// ponytail: 2s polling; switch to an attachment-modify observer if this proves flaky
async function waitForPdfFile(parent: Zotero.Item, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastPath: string | null = null;
  for (;;) {
    let seen: string | null = null;
    for (const id of parent.getAttachments()) {
      const att = Zotero.Items.get(id);
      if (att?.attachmentContentType !== "application/pdf") continue;
      try {
        const p = await att.getFilePathAsync();
        if (p && (await IOUtils.exists(p))) {
          seen = p;
          break;
        }
      } catch (_e) {
        // keep waiting
      }
    }
    if (seen && seen === lastPath) return; // path stable — move finished
    lastPath = seen;

    if (Date.now() >= deadline) {
      ztoolkit.log(
        `[SemanticTagger] PDF file for item ${parent.id} not settled after ${timeoutMs / 1000}s — tagging with whatever is available`,
      );
      return;
    }
    await Zotero.Promise.delay(2000);
  }
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
  _recentlyTagged.clear();
}
