import { VOICES } from "../../constants/voices";
import type { Episode } from "../../schemas/episode.schema";
import type { Podcast } from "../../schemas/podcast.schema";
import { speakerLabel, type Speaker } from "../../services/episodeGeneration/speakerSelection";

const SYSTEM_INSTRUCTION = `You are an audio producer preparing a two-voice podcast for a text-to-speech \
performance, following this prompting structure: a shared SCENE (location, time, atmosphere for the \
recording), one AUDIO PROFILE + DIRECTOR'S NOTES block per speaker (name, archetype, style, pacing, accent \
— specific and sensory, not vague adjectives), and a SAMPLE CONTEXT line describing what this kind of \
recording is typically used for. This runs before the conversation itself is generated, so there is no \
transcript yet — base every judgment on the podcast's description and structure, this episode's topics and \
production notes, and each speaker's persona and assigned voice trait instead.`;

function voiceTrait(voiceId: string): string {
  const voice = VOICES.find((v) => v.id === voiceId);
  return voice ? `${voice.trait} (${voice.gender.toLowerCase()})` : "unspecified";
}

export function buildProducerPromptRequest(
  podcast: Podcast,
  episode: Episode,
  speakers: [Speaker, Speaker],
): string {
  const [a, b] = speakers;
  const labelA = speakerLabel(a.name, b.name);
  const labelB = speakerLabel(b.name, a.name);
  const speakerBlocks = speakers
    .map((s) => {
      const label = s === a ? labelA : labelB;
      return `- ${label} (${s.isHost ? "host" : "guest"}): persona: "${s.persona}"; assigned voice trait: ${voiceTrait(s.voice)}`;
    })
    .join("\n");

  return `Podcast: "${podcast.title}"
Description: ${podcast.description}
Structure (how episodes of this show are built): ${podcast.structure}

This episode's topics: ${episode.topics}
Production notes for this episode: ${episode.productionNotes}

The two speakers, in the order they should appear in your output — labeled here exactly as they'll be \
labeled in the actual recording (first name only, unless a shared first name required the full name for \
this pair):
${speakerBlocks}

Produce the "scene", a "speakerProfiles" entry for each of these two speakers (in that order, using their \
label above as that entry's "name" field, exactly as given), and a "sampleContext" line.`;
}

export const producerSystemInstruction = SYSTEM_INSTRUCTION;
