import { describe, expect, it } from "vite-plus/test";

import { sortVoicesForLocale, splitUtteranceChunks } from "./speechSynthesis";
import { finalizeWavHeader } from "./voicePlayer";

describe("splitUtteranceChunks", () => {
  it("packs whole sentences up to the limit", () => {
    const chunks = splitUtteranceChunks("One two. Three four! Five six? Seven.", 20);
    expect(chunks).toEqual(["One two. Three four!", "Five six? Seven."]);
  });

  it("splits an oversized sentence at a clause or word boundary", () => {
    const chunks = splitUtteranceChunks(
      "This clause is long, and this one is longer still, and it keeps going",
      30,
    );
    expect(chunks.every((chunk) => chunk.length <= 30)).toBe(true);
    expect(chunks.join(" ")).toBe(
      "This clause is long, and this one is longer still, and it keeps going",
    );
  });

  it("returns nothing for blank text", () => {
    expect(splitUtteranceChunks("   ")).toEqual([]);
  });
});

describe("sortVoicesForLocale", () => {
  const voice = (name: string, lang: string) => ({ name, lang }) as SpeechSynthesisVoice;

  it("puts the locale's voices first and sorts each group by name", () => {
    const sorted = sortVoicesForLocale(
      [voice("Zoe", "fr-FR"), voice("Samantha", "en-US"), voice("Daniel", "en-GB")],
      "en-US",
    );
    expect(sorted.map((entry) => entry.name)).toEqual(["Daniel", "Samantha", "Zoe"]);
  });
});

describe("finalizeWavHeader", () => {
  const wav = (riffSize: number, dataSize: number, samples: number) => {
    const bytes = new Uint8Array(44 + samples);
    const view = new DataView(bytes.buffer);
    const ascii = (offset: number, text: string) => {
      for (let index = 0; index < text.length; index += 1) {
        bytes[offset + index] = text.charCodeAt(index);
      }
    };
    ascii(0, "RIFF");
    view.setUint32(4, riffSize, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    ascii(36, "data");
    view.setUint32(40, dataSize, true);
    return bytes;
  };

  it("fills in placeholder sizes from the real length", () => {
    const fixed = finalizeWavHeader(wav(0xffffffff, 0xffffffff, 100));
    const view = new DataView(fixed.buffer);
    expect(view.getUint32(4, true)).toBe(44 + 100 - 8);
    expect(view.getUint32(40, true)).toBe(100);
  });

  it("walks past an odd-sized chunk before data and clamps an oversized data size", () => {
    const base = wav(0xffffffff, 0xffffffff, 100);
    // Insert a 5-byte LIST chunk (padded to 6) between fmt and data.
    const list = new Uint8Array([76, 73, 83, 84, 5, 0, 0, 0, 1, 2, 3, 4, 5, 0]);
    const bytes = new Uint8Array(36 + list.length + 8 + 100);
    bytes.set(base.subarray(0, 36), 0);
    bytes.set(list, 36);
    bytes.set(base.subarray(36), 36 + list.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(36 + list.length + 4, 5_000_000, true);
    const fixed = finalizeWavHeader(bytes);
    const fixedView = new DataView(fixed.buffer);
    expect(fixedView.getUint32(36 + list.length + 4, true)).toBe(100);
    expect(fixedView.getUint32(4, true)).toBe(bytes.byteLength - 8);
  });

  it("leaves a consistent header and non-wav bytes alone", () => {
    const good = wav(44 + 100 - 8, 100, 100);
    expect(finalizeWavHeader(good)).toBe(good);
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(finalizeWavHeader(mp3)).toBe(mp3);
  });
});
