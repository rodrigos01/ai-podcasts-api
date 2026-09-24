const SYSTEM_INSTRUCTION = `You are the creative producer for an AI podcast platform. Given a user's \
prompt (and optionally some sample source material), you invent podcast show concepts: a title, a short \
description, a markdown "structure" describing how every episode of the show is built (segments, whether \
episodes have guests, hosts'/guests' roles), and one or more fictional hosts with a name, a voice, and a \
persona description.

Each host's "voice" field is a short, free-text description of how that host should sound — age, tone, \
gender, pacing, energy (e.g. "warm, gravelly older British male" or "bright, upbeat young woman") — not a \
pick from a fixed list; a bespoke voice will be designed from this description and the persona later. If a \
show has more than one host, write clearly distinguishable descriptions for each — no two hosts should read \
as the same voice.

Only when a host's persona specifically calls for a distinctive spoken accent (regional, national, or \
non-native) may you also set that host's "accent" field — a short, plain-English description (e.g. \
"Northern Irish", "light French accent"). Leave it unset for an ordinary/neutral voice; don't invent one \
for every host just because the field exists.

Personas should read as life-like, specific characters relevant to the show's subject matter, not generic \
placeholders.`;

export function buildOptionsPrompt(prompt: string, sourceMaterial?: string): string {
  const sourceBlock = sourceMaterial
    ? `\n\nSample source material the user provided for inspiration:\n"""\n${sourceMaterial}\n"""`
    : "";

  return `The user wants a podcast built around this prompt:\n"""\n${prompt}\n"""${sourceBlock}

Generate exactly 3 distinct podcast concept options. Each option needs a title, description, structure \
(markdown), a hosts array, and exactly 3 short "predictedChanges" strings — plausible follow-up edits the \
user might want to make to this specific option (e.g. "Make the tone more comedic", "Add a second co-host", \
"Focus more narrowly on retro hardware"). Make the 3 options meaningfully different from each other in \
tone, structure, or angle, not minor variations.`;
}

export function buildReviseSinglePrompt(
  currentOption: unknown,
  instruction: string,
): string {
  return `Here is a podcast concept option that needs to be revised:\n${JSON.stringify(currentOption)}

The user's revision instruction: "${instruction}"

Regenerate this single option, applying the instruction. Keep whatever aspects of the original the \
instruction doesn't ask to change. Return exactly 3 new "predictedChanges" appropriate to the revised option.`;
}

export function buildReviseAllPrompt(currentOptions: unknown, instruction: string): string {
  return `Here are 3 podcast concept options:\n${JSON.stringify(currentOptions)}

The user's revision instruction, to apply to ALL 3 options: "${instruction}"

Regenerate all 3 options, applying the instruction to each while keeping them meaningfully distinct from \
each other. Return exactly 3 new "predictedChanges" per option, appropriate to each revised option.`;
}

export const podcastWizardSystemInstruction = SYSTEM_INSTRUCTION;
