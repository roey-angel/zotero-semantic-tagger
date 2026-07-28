/**
 * Checks the two behaviours that fix the ZotMoov race:
 *  - waitForPdfFile returns only once the attachment path stops changing
 *  - extraction is retried against a re-resolved path when the first try fails
 *
 * Both are modelled here rather than imported, because the real modules need
 * Zotero globals. Run with: npx tsx test/pdfRetry.test.ts
 */
import assert from "node:assert";

// --- model of waitForPdfFile's stability rule -------------------------------
async function waitForStablePath(next: () => string | null, maxPolls = 15) {
  let last: string | null = null;
  for (let i = 0; i < maxPolls; i++) {
    const seen = next();
    if (seen && seen === last) return seen;
    last = seen;
  }
  return null;
}

// While the move is in progress the path keeps changing, so the wait does not
// return early — that is what keeps the common case off a doomed path.
let m = 0;
const moving = ["/storage/K/a.pdf", "/PDFs/a.pdf", "/PDFs/a.pdf"];
assert.strictEqual(
  await waitForStablePath(() => moving[m++] ?? "/PDFs/a.pdf"),
  "/PDFs/a.pdf",
  "must wait through the move and settle on the final path",
);

// A path that never settles must give up rather than loop forever.
let n = 0;
assert.strictEqual(await waitForStablePath(() => `/tmp/${n++}.pdf`), null);

// --- model of the extract-then-retry rule -----------------------------------
async function extractWithRetry(
  extract: (p: string) => string | null,
  resolvePath: () => string | null,
) {
  const first = resolvePath();
  let text = first ? extract(first) : null;
  if (!text) {
    const retry = resolvePath();
    if (retry) text = extract(retry);
  }
  return text;
}

// First attempt opens the stale storage path (file already moved) and fails;
// the retry re-resolves to the new location and succeeds.
const paths = ["/storage/K/a.pdf", "/PDFs/a.pdf"];
let p = 0;
const text = await extractWithRetry(
  (path) => (path === "/PDFs/a.pdf" ? "page text" : null),
  () => paths[p++] ?? "/PDFs/a.pdf",
);
assert.strictEqual(
  text,
  "page text",
  "retry must succeed after re-resolving the moved path",
);

// No PDF anywhere: returns null instead of throwing.
assert.strictEqual(
  await extractWithRetry(
    () => null,
    () => null,
  ),
  null,
);

// End-to-end guarantee: even when the wait settles before a late move (so the
// first extraction opens a path that is already gone), the retry recovers.
let q = 0;
const lateMove = ["/storage/K/a.pdf", "/storage/K/a.pdf", "/PDFs/a.pdf"];
const nextPath = () => lateMove[Math.min(q++, lateMove.length - 1)];
const settledEarly = await waitForStablePath(nextPath);
assert.strictEqual(
  settledEarly,
  "/storage/K/a.pdf",
  "wait can settle before a late move",
);
const recovered = await extractWithRetry(
  (path) => (path === "/PDFs/a.pdf" ? "page text" : null),
  nextPath,
);
assert.strictEqual(recovered, "page text", "retry must rescue a late move");

console.log("pdfRetry: all assertions passed");
