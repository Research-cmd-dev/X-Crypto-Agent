import { describe, it, expect } from "vitest";
import {
  extractUrls,
  firstWebsiteUrl,
  firstGithubUrl,
  githubOwnerFromUrl,
  extractMentions,
  extractContractAddress,
} from "@/lib/extract";

describe("extractContractAddress", () => {
  it("prefers a pump.fun mint (ends in 'pump')", () => {
    const bio = "Decentralized AI.\n\nCA: EmcxFTNVDqyLHp11NvwvLZ4D7LKGbG9i7B8RF7dwpump";
    expect(extractContractAddress(bio)).toBe("EmcxFTNVDqyLHp11NvwvLZ4D7LKGbG9i7B8RF7dwpump");
  });
  it("falls back to a labelled contract address", () => {
    expect(
      extractContractAddress("contract: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"),
    ).toBe("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  });
  it("returns null when there is no address", () => {
    expect(extractContractAddress("just a normal bio with no token")).toBeNull();
    expect(extractContractAddress(null)).toBeNull();
  });
});

describe("website / github extraction", () => {
  it("picks the project site and ignores socials/shorteners", () => {
    const urls = ["https://t.co/abc", "https://x.com/foo", "https://gem.ai/docs"];
    expect(firstWebsiteUrl(urls)).toBe("https://gem.ai/docs");
  });
  it("finds github links and their owner", () => {
    const urls = ["https://gem.ai", "https://github.com/leyten/shard"];
    expect(firstGithubUrl(urls)).toBe("https://github.com/leyten/shard");
    expect(githubOwnerFromUrl("https://github.com/leyten/shard")).toBe("leyten");
    expect(githubOwnerFromUrl("https://gem.ai")).toBeNull();
  });
  it("pulls urls (explicit + bare domains) from post text", () => {
    const urls = extractUrls("check https://gem.ai/app and our docs at gem.gitbook.io soon");
    expect(urls).toContain("https://gem.ai/app");
  });
});

describe("extractMentions", () => {
  it("collects distinct dev/collaborator handles from posts", () => {
    const text = "shipping with @leyten and @leyten, shout out @nvidia";
    expect(extractMentions(text)).toEqual(["leyten", "nvidia"]);
  });
});
