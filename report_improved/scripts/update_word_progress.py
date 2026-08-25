#!/usr/bin/env python3
"""Count finished LaTeX chapters and generate the progress counter."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


REPORT_DIR = Path(__file__).resolve().parent.parent
MAIN_TEX = REPORT_DIR / "main.tex"
OUTPUT_TEX = REPORT_DIR / "build" / "word-progress.tex"
FINISHED_CHAPTER = re.compile(
    r"^[ \t]*\\hoofdstukafgewerkt\{([^{}]+)\}", re.MULTILINE
)


def count_words(chapter: str) -> int:
    chapter_path = REPORT_DIR / chapter
    if not chapter_path.is_file():
        raise FileNotFoundError(f"Afgewerkt hoofdstuk niet gevonden: {chapter}")

    result = subprocess.run(
        ["texcount", "-1", "-sum", "-merge", chapter],
        cwd=REPORT_DIR,
        check=True,
        capture_output=True,
        text=True,
    )
    for line in reversed(result.stdout.splitlines()):
        if line.strip().isdigit():
            return int(line.strip())
    raise RuntimeError(f"Texcount gaf geen woordenaantal voor {chapter}")


def main() -> int:
    source = MAIN_TEX.read_text(encoding="utf-8")
    chapters = FINISHED_CHAPTER.findall(source)
    counts = [(chapter, count_words(chapter)) for chapter in chapters]
    total = sum(count for _, count in counts)

    details = "\n".join(f"% {chapter}: {count}" for chapter, count in counts)
    generated = (
        "% Automatisch gegenereerd door scripts/update_word_progress.py.\n"
        "% Niet handmatig aanpassen.\n"
        f"{details}\n"
        f"\\setcounter{{afgewerktewoorden}}{{{total}}}\n"
    )

    OUTPUT_TEX.parent.mkdir(parents=True, exist_ok=True)
    if not OUTPUT_TEX.exists() or OUTPUT_TEX.read_text(encoding="utf-8") != generated:
        OUTPUT_TEX.write_text(generated, encoding="utf-8")

    print(f"Woordenvoortgang: {total} woorden uit {len(chapters)} hoofdstukken")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Fout bij automatische woordtelling: {error}", file=sys.stderr)
        raise SystemExit(1)
