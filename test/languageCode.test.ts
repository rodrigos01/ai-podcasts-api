import { describe, expect, it } from "vitest";
import { languageCodeSchema } from "../src/schemas/common.schema";
import { podcastCreateSchema, podcastUpdateSchema } from "../src/schemas/podcast.schema";
import { podcastOptionSchema } from "../src/schemas/wizard.schema";
import { normalizeLanguageCode } from "../src/utils/languageCode";

describe("normalizeLanguageCode", () => {
  it("canonicalises underscores and casing to BCP-47", () => {
    expect(normalizeLanguageCode("en_US")).toBe("en-US");
    expect(normalizeLanguageCode("PT-br")).toBe("pt-BR");
    expect(normalizeLanguageCode(" es-419 ")).toBe("es-419");
    expect(normalizeLanguageCode("zh_hans_cn")).toBe("zh-Hans-CN");
    expect(normalizeLanguageCode("fr")).toBe("fr");
  });

  it("returns undefined for anything that isn't a language tag", () => {
    for (const bad of ["", "english", "en-US-x-whatever", "1234", "e", "en_"]) {
      expect(normalizeLanguageCode(bad)).toBeUndefined();
    }
  });
});

describe("languageCodeSchema", () => {
  it("treats an unrecognisable or non-string value as not set, never an error", () => {
    expect(languageCodeSchema.parse("pt_BR")).toBe("pt-BR");
    expect(languageCodeSchema.parse("not a code")).toBeUndefined();
    expect(languageCodeSchema.parse(42)).toBeUndefined();
  });
});

const host = { name: "A", voice: "warm", persona: "p" };

describe("languageCode on podcasts and wizard options", () => {
  it("is optional everywhere, so existing clients are unaffected, and left absent when not sent", () => {
    const create = podcastCreateSchema.parse({ title: "t", description: "d", structure: "s", hosts: [host] });
    expect("languageCode" in create).toBe(false);
    expect(podcastUpdateSchema.parse({})).toEqual({});
    const option = podcastOptionSchema.parse({
      title: "t",
      description: "d",
      structure: "s",
      hosts: [host],
      predictedChanges: ["a", "b", "c"],
    });
    expect(option.languageCode).toBeUndefined();
  });

  it("is canonicalised when sent", () => {
    const create = podcastCreateSchema.parse({
      title: "t",
      description: "d",
      structure: "s",
      hosts: [host],
      languageCode: "pt_BR",
    });
    expect(create.languageCode).toBe("pt-BR");
    expect(podcastUpdateSchema.parse({ languageCode: "en_us" }).languageCode).toBe("en-US");
  });
});
