#!/usr/bin/env python3
"""Cheap, repeatable checks on exported transcripts (see ../SKILL.md).

  analyze.py stats   FILE...            per-file format and conversation-shape stats
  analyze.py overlap TARGET EARLIER...  8-word sequences TARGET shares verbatim with earlier episodes

Files are the "Name: line" transcripts export.ts writes (a leading "# title"
line is ignored). Stats are heuristics for spotting a regression, not a quality score.
"""
import re
import sys
from collections import Counter


def read(path):
    text = open(path, encoding="utf-8").read()
    return re.sub(r"\A# [^\n]*\n\n", "", text).strip()


def turns(text):
    """(label, first line of the spoken text, whole turn) per labelled paragraph; None label = unparsed paragraph."""
    out = []
    for para in re.split(r"\n\n+", text):
        m = re.match(r"^([^\s:\[\]()]+(?: [^\s:\[\]()]+)?):\s(.*)", para, re.S)
        out.append((m.group(1), m.group(2).split("\n")[0], para) if m else (None, para, para))
    return out


def stats(path):
    ts = turns(read(path))
    labelled = [t for t in ts if t[0]]
    n = len(labelled) or 1
    labels = Counter(t[0] for t in labelled)
    consecutive = sum(1 for a, b in zip(labelled, labelled[1:]) if a[0] == b[0])
    return {
        "words": len(read(path).split()),
        "turns": len(labelled),
        "unparsed_paragraphs": len(ts) - len(labelled),  # should be 0: anything else is a format problem
        "words_per_turn": round(sum(len(t[1].split()) for t in labelled) / n, 1),
        "question_ending_%": round(100 * sum(t[1].rstrip().endswith("?") for t in labelled) / n, 1),
        "style_lines": sum(1 for t in labelled if re.search(r"\nStyle:", t[2])),
        "turns_with_digits": sum(bool(re.search(r"\d", t[1])) for t in labelled),  # "write numbers as words"
        "backchannel_at_turn_edge": sum(bool(re.match(r"^\s*\|", t[1]) or re.search(r"\|\s*$", t[1])) for t in labelled),
        "same_speaker_back_to_back": consecutive,
        "labels": dict(labels),  # exactly the two expected, roughly balanced
    }


def grams(text, n=8):
    words = re.findall(r"[\w']+", text.lower())
    return {" ".join(words[i : i + n]) for i in range(len(words) - n + 1)}


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("stats", "overlap"):
        sys.exit(__doc__)
    if sys.argv[1] == "stats":
        for path in sys.argv[2:]:
            print(path.rsplit("/", 1)[-1], stats(path))
    else:
        target, earlier = sys.argv[2], sys.argv[3:]
        mine = grams(read(target))
        seen = set().union(*[grams(read(p)) for p in earlier]) if earlier else set()
        shared = len(mine & seen)
        print(f"{target.rsplit('/', 1)[-1]}: {shared} of {len(mine)} 8-grams shared verbatim ({100 * shared / max(len(mine), 1):.2f}%)")


main()
