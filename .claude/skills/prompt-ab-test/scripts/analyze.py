#!/usr/bin/env python3
"""Cheap, repeatable checks on exported transcripts (see ../SKILL.md).

  analyze.py stats   FILE...            per-file format and conversation-shape stats
  analyze.py checks  FILE...            angle-bracket tags, backchannels (|..|) and recap phrases
  analyze.py quotes  FILE...            length of quoted source passages read out (diary readings, citations)
  analyze.py overlap TARGET EARLIER...  8-word sequences TARGET shares verbatim with earlier episodes

Files are the "Name: line" transcripts export.ts writes (a leading "# title"
line is ignored). Stats are heuristics for spotting a regression, not a quality score.
"""
import re
import statistics
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


RECAP = re.compile(
    r"\b(to recap|let'?s recap|recap(ping)?|in summary|to sum (it )?up|to summari[sz]e|so far today|"
    r"we'?ve (covered|seen|talked)|what we'?ve (covered|seen)|last time|previous episode|last episode|"
    r"earlier today|as we (said|saw|covered))\b",
    re.I,
)


def checks(path):
    """Format rules the prompt states: tags are 1-2 words (or <claps>), pipes never open or close a turn.
    Recap-phrase hits are only candidates: read them, since a brief callback is fine and a recap is not."""
    text = read(path)
    tags = re.findall(r"<[^>]*>", text)
    bad = [t for t in tags if len(t.strip("<>").split()) > 2 and t.lower() != "<claps>"]
    spoken = [t[1] for t in turns(text) if t[0]]
    long_turns = [t for t in spoken if len(t.split()) > 40]
    return {
        "tags": len(tags),
        "tags_not_1_2_words": len(bad),
        "invalid_tag_examples": [b[:60] for b in bad[:4]],
        "common_tags": dict(Counter(t.lower() for t in tags).most_common(6)),
        "backchannels": len(re.findall(r"\|[^|]{1,60}\|", text)),
        "turns_with_backchannel": sum(bool(re.search(r"\|[^|]+\|", t)) for t in spoken),
        "long_turns_(40+_words)": len(long_turns),
        "long_turns_with_backchannel": sum("|" in t for t in long_turns),
        "recap_phrase_hits": [m[0] for m in RECAP.findall(text)][:6],
    }


def quotes(path, min_words=12):
    """How much source text is read out at a time: quoted passages of min_words+ words."""
    spans = []
    for _, spoken, _ in (t for t in turns(read(path)) if t[0]):
        spans += [n for n in (len(m.group(1).split()) for m in re.finditer(r"[\"“]([^\"”]{12,}?)[\"”]", spoken)) if n >= min_words]
    spans.sort()
    return {
        "readings": len(spans),
        "median_words": statistics.median(spans) if spans else 0,
        "p90_words": spans[int(0.9 * len(spans))] if spans else 0,
        "longest": spans[-1] if spans else 0,
        "over_60_words": sum(n > 60 for n in spans),
    }


def grams(text, n=8):
    words = re.findall(r"[\w']+", text.lower())
    return {" ".join(words[i : i + n]) for i in range(len(words) - n + 1)}


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("stats", "checks", "quotes", "overlap"):
        sys.exit(__doc__)
    if sys.argv[1] in ("stats", "checks", "quotes"):
        fn = {"stats": stats, "checks": checks, "quotes": quotes}[sys.argv[1]]
        for path in sys.argv[2:]:
            print(path.rsplit("/", 1)[-1], fn(path))
    else:
        target, earlier = sys.argv[2], sys.argv[3:]
        mine = grams(read(target))
        seen = set().union(*[grams(read(p)) for p in earlier]) if earlier else set()
        shared = len(mine & seen)
        print(f"{target.rsplit('/', 1)[-1]}: {shared} of {len(mine)} 8-grams shared verbatim ({100 * shared / max(len(mine), 1):.2f}%)")


main()
