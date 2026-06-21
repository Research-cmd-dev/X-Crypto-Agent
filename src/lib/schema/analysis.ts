import { z } from "zod";

/**
 * The single source of truth for the deep-research output. This schema is reused
 * three ways:
 *   1. Runtime validation of an assembled report before it is stored.
 *   2. Per-agent `output_format` schemas for structured LLM output.
 *   3. TypeScript types (via `z.infer`).
 *
 * NOTE on structured outputs: we deliberately avoid `.min()/.max()/.url()` on
 * the wire. The model occasionally returns out-of-range values; rather than fail
 * the whole parse we accept plain ints/strings and clamp/normalize in code
 * (see `lib/schema/scoring.ts` -> `clampScore`). Ranges are documented via
 * `.describe()` so the model still aims for 0-100.
 */

/** A 0-100 sub-score. Not bounded on the wire; clamp downstream. */
const scoreField = (what: string) =>
  z.number().int().describe(`${what} score from 0 (poor) to 100 (excellent)`);

export const notableFollowerSchema = z.object({
  handle: z.string().describe("X handle without @"),
  name: z.string().nullable(),
  why: z.string().describe("Why this follower is notable (e.g. @nvidia, @AMD, a known founder/VC)"),
});

export const followerSpikeSchema = z.object({
  date: z.string().describe("Approx ISO date or period of the spike"),
  delta: z.number().describe("Approx follower change in the period"),
  note: z.string().nullable(),
});

export const followerQualitySchema = z.object({
  score: scoreField("Follower quality"),
  notes: z.string(),
});

export const accountSchema = z.object({
  handle: z.string(),
  userId: z.string().nullable(),
  displayName: z.string().nullable(),
  bio: z.string().nullable(),
  verified: z.boolean().nullable(),
  createdAt: z.string().nullable().describe("Account creation date if known"),
  location: z.string().nullable(),
});

export const profileSchema = z.object({
  followerCount: z.number().nullable(),
  followingCount: z.number().nullable(),
  followerRatio: z.number().nullable().describe("followers / following"),
  followerSpikes: z.array(followerSpikeSchema).describe("Notable follower growth spikes; [] if none"),
  followerQuality: followerQualitySchema,
  notableFollowers: z.array(notableFollowerSchema).describe("Notable/high-signal followers; [] if none"),
});

export const websiteSchema = z.object({
  url: z.string().nullable(),
  detected: z.boolean(),
  score: scoreField("Website quality"),
  design: z.string().describe("Assessment of visual design / professionalism"),
  documentation: z.string().describe("Quality of docs / whitepaper"),
  roadmap: z.string().describe("Presence and quality of a roadmap"),
  teamInfo: z.string().describe("Presence and credibility of team info"),
  githubLinksOnSite: z.array(z.string()).describe("GitHub URLs found on the site; [] if none"),
  notes: z.string(),
});

export const githubSchema = z.object({
  url: z.string().nullable(),
  detected: z.boolean(),
  score: scoreField("GitHub quality"),
  activity: z.string().describe("Commit/PR/issue activity assessment"),
  stars: z.number().nullable(),
  relevance: z.string().describe("How relevant the repo(s) are to the project's claims"),
  recentCommits: z.number().nullable().describe("Approx commits in the last ~90 days"),
  contributors: z.number().nullable(),
  notes: z.string(),
});

export const developerSchema = z.object({
  handle: z.string().nullable().describe("X handle of an associated developer"),
  name: z.string().nullable(),
  githubUrl: z.string().nullable(),
  signals: z.array(z.string()).describe("Positive/negative signals about this developer"),
  qualityNote: z.string(),
});

export const engagementSchema = z.object({
  momentumScore: scoreField("Engagement momentum"),
  avgLikes: z.number().nullable(),
  avgReposts: z.number().nullable(),
  cadence: z.string().describe("Posting cadence assessment"),
  notes: z.string(),
});

export const technicalDepthSchema = z.object({
  score: scoreField("Technical depth"),
  notes: z.string(),
});

export const priceSchema = z.object({
  token: z.string().nullable().describe("Ticker/symbol if a token exists"),
  marketCapUsd: z.number().nullable(),
  volume24hUsd: z.number().nullable(),
  priceUsd: z.number().nullable(),
  source: z.string().describe("Where the price data came from (e.g. coingecko, dexscreener)"),
  notes: z.string(),
});

export const redFlagSeveritySchema = z.enum(["low", "med", "high"]);

export const redFlagSchema = z.object({
  severity: redFlagSeveritySchema,
  code: z.string().describe("Short machine code, e.g. 'fake_followers', 'no_github'"),
  message: z.string(),
});

/** The full assembled report. */
export const analysisReportSchema = z.object({
  account: accountSchema,
  profile: profileSchema,
  website: websiteSchema,
  github: githubSchema,
  developers: z.array(developerSchema).describe("Associated developer accounts; [] if none"),
  engagement: engagementSchema,
  technicalDepth: technicalDepthSchema,
  price: priceSchema,
  redFlags: z.array(redFlagSchema).describe("Red flags; [] if none"),
  summary: z.string().describe("2-4 sentence executive summary"),
});

export type AnalysisReport = z.infer<typeof analysisReportSchema>;
export type Account = z.infer<typeof accountSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type Website = z.infer<typeof websiteSchema>;
export type GitHub = z.infer<typeof githubSchema>;
export type Developer = z.infer<typeof developerSchema>;
export type Engagement = z.infer<typeof engagementSchema>;
export type TechnicalDepth = z.infer<typeof technicalDepthSchema>;
export type Price = z.infer<typeof priceSchema>;
export type RedFlag = z.infer<typeof redFlagSchema>;

// ── Per-agent output schemas (focused → more reliable structured output) ─────

/** X Analyzer (the x-account-crypto-analyzer skill) output slice. */
export const xAnalyzerOutputSchema = z.object({
  account: accountSchema,
  profile: profileSchema,
  engagement: engagementSchema,
  developers: z.array(developerSchema),
  technicalDepth: technicalDepthSchema,
  websiteUrl: z.string().nullable().describe("Best website URL found on the profile/site, or null"),
  githubUrl: z.string().nullable().describe("Best GitHub URL/org found, or null"),
  contractAddress: z
    .string()
    .nullable()
    .describe("Token contract address / mint from the bio or posts (e.g. a Solana pump.fun CA), or null"),
  redFlags: z.array(redFlagSchema),
  summary: z.string().describe("2-4 sentence executive summary of the project's promise and risks"),
});
export type XAnalyzerOutput = z.infer<typeof xAnalyzerOutputSchema>;

export const websiteAnalyzerOutputSchema = z.object({ website: websiteSchema });
export type WebsiteAnalyzerOutput = z.infer<typeof websiteAnalyzerOutputSchema>;

export const githubAnalyzerOutputSchema = z.object({
  github: githubSchema,
  developers: z.array(developerSchema).describe("Developer enrichment from GitHub; [] if none"),
});
export type GithubAnalyzerOutput = z.infer<typeof githubAnalyzerOutputSchema>;

export const priceAgentOutputSchema = z.object({ price: priceSchema });
export type PriceAgentOutput = z.infer<typeof priceAgentOutputSchema>;
