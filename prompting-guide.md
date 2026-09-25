# Gemini 3.8 Flash TTS Prompting Guide

*A reference for writing transcripts and performance directions for Gemini 3.8 Flash TTS (`gemini-3.8-flash-tts`).*

Source: adapted from Google's Gemini API documentation on [speech generation](https://ai.google.dev/gemini-api/docs/speech-generation#prompting-guide) (CC BY 4.0).

---

## The Core Concept

Gemini 3.8 TTS models treat input text strictly as a **verbatim transcript**. Unlike earlier preview models where stage directions were embedded in plain text or long "Director's Notes" blocks, Gemini 3.8 TTS cleanly separates:
1. **Turn-level delivery style (`speech_metadata.style`)**: Sustained delivery attributes (emotion, prosody, overall pace) applied across an entire turn.
2. **Point-in-time inline tags (`<...>`)**: Momentary non-speech vocal bursts, breaths, or pauses placed directly in the spoken transcript.

---

## Turn Structure in Transcripts

Transcripts are written as a sequence of turns separated by a single blank line:

```
Speaker 1: Text to be spoken aloud
Style: optional short delivery style

Speaker 2: Another spoken line

Speaker 1: Third spoken line
Style: whispering
```

- **Speaker line (`Speaker: Text`)**: The speaker's exact canonical label followed by a colon and the text to speak.
- **Style line (`Style: ...`)**: Optional concise delivery instruction for that turn.
- **No comment lines**: Do not include `// Turn N` comment headers in the output.

---

## Style Field vs. Inline Tags

| Scope | Where to place | Examples |
|---|---|---|
| **Turn-level** (sustained across the whole turn) | `Style: ...` (`speech_metadata.style`) | `Style: whispering`, `Style: speaking rapidly`, `Style: out of breath`, `Style: sarcastic`, `Style: cheerful, energetic`, `Style: angry tone`, `Style: deadpan` |
| **Point-in-time** (occurs at a specific moment) | Inline in text using `<...>` | `<cough>`, `<breath>`, `<gasp>`, `<sigh>`, `<laughter>`, `<chuckle>`, `<throat-clearing>`, `<short pause>`, `<long pause>` |

### Delivery Cues & Style in Transcript's Language

Write all inline cues (`<...>`) and `Style:` instructions in the same language as the transcript:
- **English**: `<laughter>`, `<sigh>`, `<gasp>`, `<short pause>`, `Style: whispering`, `Style: sarcastic`
- **Spanish**: `<risas>`, `<suspiro>`, `<jadeo>`, `<pausa corta>`, `Style: susurrando`, `Style: sarcástico`
- **Portuguese**: `<risos>`, `<suspiro>`, `<ofegante>`, `<pausa curta>`, `Style: sussurrando`, `Style: sarcástico`
- **French**: `<rires>`, `<soupir>`, `<halètement>`, `<pause courte>`, `Style: chuchoté`, `Style: sarcastique`

### Turn-Level Delivery (`Style:`)

- Use `Style:` for sustained attributes: overall pacing, emotional coloring, or vocal register across the turn.
- **Keep it concise**: A short descriptive phrase (e.g. `Style: sarcastic`, `Style: muttering`).
- **Omit when normal**: Most turns do not need a `Style:` line — let the speaker's designed voice carry natural conversational dialogue.
- **Never put immutable traits in `Style:`**: Do not put character backstory, age, names, or permanent accents in `Style:`. Those belong in Voice Design.

### Point-in-Time Vocal Bursts (Inline `<...>` Tags)

Place non-speech human vocalizations directly inline in the dialogue text:
- **Laughter / Amusement**: `<chuckle>`, `<chuckles>`, `<giggle>`, `<cackle>`, `<laugh>`, `<laughter>`, `<snicker>`
- **Breathing / Relief**: `<breath>`, `<heavy breath>`, `<exhales>`, `<gasp>`, `<pant>`, `<phew>`, `<sigh>`, `<sighs>`, `<yawn>`
- **Effort / Displeasure**: `<groan>`, `<grunt>`, `<grr>`, `<hiss>`, `<moan>`, `<whimper>`, `<argh>`
- **Hesitation / Clearing**: `<throat-clearing>`, `<cough>`, `<sneeze>`, `<snort>`, `<sob>`, `<tsk>`
- **Pauses**: `<short pause>`, `<long pause>`

*Note: Stick to human vocalizations rather than sound effects or non-vocal audio cues.*

---

## Backchanneling and Overlapping Speech (`|...|`)

In natural human dialogue, listeners interject brief reactions or talk simultaneously without waiting for a full turn change. Gemini 3.8 Flash TTS synthesizes multi-speaker audio with concurrent overlapping voices when listener reactions are wrapped in pipe characters (`|reaction|`) inside the active speaker's line:

1. **Short backchannel exchanges**:
   Layer brief listener reactions inside the active speaker's sentence so the listener reacts while the speaker talks:
   - `Speaker A: "So the launch is Thursday |oh hmm| Are we actually ready?"`
   - `Speaker B: "Ready enough |oh really?| The last blocker cleared this morning."`
   - `Speaker A: "Then let's ship it |absolutely| and watch the dashboards."`

2. **Overlapping and interleaved speech**:
   Use pipe segments to simulate simultaneous speech, chorus lines, or excited interruptions:
   - *Simultaneous countdown/chorus*: `"Let's surprise him on three |ok| ready?"` followed by `"one. two. three. |happy| happy |birthday| birthday!"`
   - *Interleaved overlap*: `"We were completely blown away |no way| when the final numbers were announced!"`

Always write listener backchannel phrases in the language of the transcript (e.g. `|oh hmm|`, `|ah claro|`, `|sério?|`, `|exactement|`).

---

## Pacing, Pauses, and Rhythm

1. **Punctuation & Ellipses**: Use commas, em-dashes (`--`), and ellipses (`...`) for natural hesitation and conversational rhythm.
2. **Explicit Pauses**: Insert pauses (`<short pause>`, `<long pause>`) where a speaker pauses to think or react.
3. **Conversational Disfluencies**: Include realistic natural speech hesitations (e.g., *"Oh uh yeah I think... hm, so that's interesting"*).
4. **Emphasis**: Capitalize specific words to place natural vocal stress and punch (e.g., *"This is a VERY important point!"*).

---

## What to Avoid

- **No markdown formatting**: Do NOT use `**bold**`, `*italics*`, `# headers`, bullet points, or code formatting. The TTS model reads punctuation and symbols literally.
- **No colon prefixes in sentences**: Never start a line or sentence with `"Word:"` (e.g., `"Watch this: ..."`). It can be misinterpreted as a speaker label. Use dashes instead (`"Watch this — ..."`).
- **No comment headers**: Do not emit `// Turn N` lines in generated transcripts.