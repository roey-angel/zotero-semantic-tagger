#!/usr/bin/env python3
"""
Extract text from a PDF file and write it to an output file.

Usage:
    python extract_pdf.py <path_to_pdf> <output_txt_path>

Requires:
    pip install PyMuPDF

Returns exit code 0 on success, non-zero on failure.
"""

import sys


def extract_with_pymupdf(path: str) -> str:
    import fitz  # PyMuPDF

    doc = fitz.open(path)
    parts = []
    for page in doc:
        text = page.get_text()
        if text.strip():
            parts.append(text)
    doc.close()
    return "\n".join(parts)


def extract_with_pdfplumber(path: str) -> str:
    import pdfplumber

    parts = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if text and text.strip():
                parts.append(text)
    return "\n".join(parts)


def main():
    if len(sys.argv) < 3:
        print("Usage: extract_pdf.py <pdf_path> <output_path>", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]
    output_path = sys.argv[2]

    # Try PyMuPDF first, fall back to pdfplumber
    try:
        text = extract_with_pymupdf(pdf_path)
    except ImportError:
        try:
            text = extract_with_pdfplumber(pdf_path)
        except ImportError:
            print(
                "Neither PyMuPDF nor pdfplumber is installed.\n"
                "Install one with: pip install PyMuPDF",
                file=sys.stderr,
            )
            sys.exit(2)
    except Exception as e:
        print(f"Error extracting PDF: {e}", file=sys.stderr)
        sys.exit(3)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(text)


if __name__ == "__main__":
    main()
