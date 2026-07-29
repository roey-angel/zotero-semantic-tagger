# Zotero forum announcement — Semantic Tagger v0.1.0

Post at: https://forums.zotero.org/  ·  Category: **Plugins**

**Title:** [New Plugin] Semantic Tagger — auto-tag new items from your existing tag library using Claude

---

Hi all,

I'd like to announce **Semantic Tagger**, a plugin for Zotero 7+ that automatically applies tags to newly added papers — using only tags that already exist in your library.

When an item is added (import, browser connector, Add by Identifier, or a PDF arriving via Find Full Text), the plugin reads the title, abstract, and optionally the PDF text, and asks Anthropic's Claude API to pick the best-matching tags from your existing tag list. It never invents new tags: everything the model returns is validated against your library before being written, so the worst case is a wrong tag *from your own vocabulary* on one item. You can also batch-tag any selection via right-click → "Semantic Tagger: Tag Selected Items".

Features:

- Tags only from your existing library — non-destructive by design
- Strictness slider: from 2–4 core-topic tags up to 6–12 broader ones
- Model picker: once your API key is set, it lists the models your key can actually access
- Synonym groups (e.g. teach it that CH4 = methane = natural gas)
- PDF text via Zotero's own full-text cache, with an optional Python/PyMuPDF fallback; works alongside file-moving plugins like ZotMoov
- Session token budget with warnings, and an automatic pause if your API credits run out

You'll need your own Claude API key from console.anthropic.com (pay-per-use; a typical paper costs a fraction of a cent). The README documents exactly what data is sent and how the key is stored — please read the Privacy & Security section before using it.

Download and documentation:
https://github.com/roey-angel/zotero-semantic-tagger

This is a first public release (v0.1.0), developed and tested on Linux with Zotero 7; macOS and Windows should work but are untested — the Python PDF path in particular is macOS/Linux only. Feedback and bug reports very welcome via the GitHub issue tracker.

Disclosure: the plugin was written with substantial help from Claude (Anthropic's model), which is also credited as co-author in the commit history.

---

## Notes before posting

- The disclosure line and the "untested on macOS/Windows" caveat are optional — forum regulars tend to ask about both, so being upfront usually lands better. Delete either if you prefer.
- Release link: https://github.com/roey-angel/zotero-semantic-tagger/releases/tag/v0.1.0
- Direct XPI: https://github.com/roey-angel/zotero-semantic-tagger/releases/download/v0.1.0/semantic-tagger.xpi
