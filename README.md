# Semantic Tagger

A Zotero 7 plugin that automatically applies semantic tags to scientific papers using the Claude API.

When a paper is added to your library, the plugin reads its title, abstract, and PDF text, then asks Claude to select matching tags from your **existing** Zotero tag library. It never creates new tags.

## Features

- Automatically tags new items on import
- Also triggers when a PDF is attached via **Find Full Text**
- Manual batch tagging via right-click → **Semantic Tagger: Tag Selected Items**
- PDF text extraction using the bundled Python helper (PyMuPDF / pdfplumber)
- Synonym groups: teach Claude that `CH4`, `methane`, and `natural gas` are the same concept
- Strictness slider: control how liberally tags are applied
- Session token budget: warns you when API usage exceeds 20,000 tokens

## Requirements

- Zotero 7
- A Claude API key from [console.anthropic.com](https://console.anthropic.com)
- Python 3 with PyMuPDF installed (`pip install PyMuPDF`) — required for PDF text extraction

## Installation

1. Download the latest `.xpi` from the [Releases](../../releases) page
2. In Zotero: **Tools → Add-ons → Install Add-on From File**
3. Open **Edit → Preferences → Semantic Tagger** and enter your Claude API key

## Configuration

| Setting | Description |
|---|---|
| Automatically tag new items | Enable/disable the watcher that fires on import |
| Claude API Key | Your Anthropic API key |
| Strictness | Controls tag count and selectivity: lax (0) = 6–12 broad tags; strict (100) = 2–4 primary-focus tags only |
| Synonym file | Path to a `.txt` file defining synonym groups (see below) |
| Python executable | Override if `python3` is not on your PATH |
| extract_pdf.py path (optional override) | Use a custom extraction script instead of the bundled one |

## Synonym file format

One group per line, terms separated by semicolons. Lines starting with `#` are comments.

```
# Example synonyms.txt
methane; CH4; natural gas
biocrust; biological soil crust; cryptogam; BSC
soil organic carbon; SOC; soil carbon
```

## How tagging works

### Trigger

The plugin fires when:
- A new item is added (manual import, browser connector, drag-and-drop)
- A paper is added via **Add Item by Identifier** (DOI, ISBN, arXiv ID)
- A PDF is attached to an existing item via **Find Full Text**
- You manually select items and use the right-click menu

### Content collected

1. **Title** — from Zotero item metadata
2. **Abstract** — from Zotero item metadata
3. **PDF full text** — extracted by running `extract_pdf.py` (first 8,000 characters sent to Claude). Falls back to title + abstract if Python or PyMuPDF is unavailable.

### Claude API call

A single call is made to `claude-sonnet-4-6`. The prompt is:

---

**System prompt:**

```
You are a scientific literature tagger. Your task is to select tags from a
provided library that best describe a given paper.

RULES:
1. You may ONLY use tags from the provided library — never invent new tags.
2. Select between N and M tags (range set by the strictness slider).
3. [strictness instruction — varies with the strictness slider; see table below]
4. Ignore the references/bibliography section of the paper — do not use
   cited works to infer tags.
5. Return ONLY a JSON array of tag strings, exactly as they appear in the
   library. No explanation.

Synonym groups (treat all entries in a group as equivalent):
methane; CH4; natural gas
biocrust; biological soil crust; cryptogam; BSC
```

**User message:**

```
Tag library:
soil carbon
methane
nitrogen cycling
climate change
permafrost
[... all tags in your Zotero library, one per line ...]

---

Title: Methane flux in Arctic tundra under warming scenarios

Abstract: We measured CH4 emissions from permafrost soils across a
latitudinal gradient...

PDF text (excerpt):
[first 8,000 characters of the PDF]
```

---

The strictness setting controls both the number of tags and how liberally they are applied:

| Setting | Tag count | Rule |
|---|---|---|
| **Lax (0–33)** | 6–12 | Apply a tag if the paper meaningfully mentions, uses, or engages with the concept — even in passing, as background, or in the methods section |
| **Moderate (34–66)** | 4–7 | Apply a tag if the paper substantially discusses or relies on the concept, even if it is not the primary focus |
| **Strict (67–100)** | 2–4 | Only apply a tag if it describes a central research topic — something the paper directly investigates, develops, or makes a primary contribution to |

### Safety filter

Claude's response is validated against your actual tag library before anything is written. Any tag not found in your library (case-insensitive) is silently dropped. This prevents hallucinated tags from being applied.

### Session token budget

The plugin tracks cumulative token usage during the Zotero session. When usage exceeds **20,000 tokens**, a dialog asks whether to continue. If you decline, further automatic tagging is paused for the rest of the session. You can still tag manually via the right-click menu — each call will prompt again.

## Development

```bash
cd zotero-semantic-tagger
npm install
npm run build        # build the XPI
npm start            # build + live reload in Zotero dev build
npm run lint:check   # check formatting and lint
npx tsc --noEmit     # type-check only
```

Python helper setup:
```bash
pip install PyMuPDF
```
