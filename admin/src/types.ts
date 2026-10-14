// The slice of the API's responses the admin reads (see src/schemas/*.ts in the API).
export interface Person {
  id: string;
  name: string;
  persona: string;
  accent?: string;
  voice?: string;
}

export interface Podcast {
  id: string;
  title: string;
  description: string;
  structure: string;
  languageCode?: string;
  hosts: Person[];
  ownerId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type EpisodeStatus = "generating" | "streamable" | "ready" | "failed";

export interface Episode {
  id: string;
  title: string;
  topics: string;
  length: "short" | "medium" | "long";
  productionNotes?: string;
  participantHostIds: string[];
  guests: Person[];
  status: EpisodeStatus;
  transcript: string | null;
  error: string | null;
  audioComplete?: boolean;
  audioDurationSeconds?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface EpisodeStatusResponse {
  status: EpisodeStatus;
  error: string | null;
  audioComplete: boolean;
}

export interface Source {
  id: string;
  title: string;
  contents: string;
  sourceType: "text" | "pdf";
  createdAt: number;
}
