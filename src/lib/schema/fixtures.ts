import type {
  AnalysisReport,
  Account,
  Profile,
  Website,
  GitHub,
  Engagement,
  TechnicalDepth,
  Price,
} from "@/lib/schema/analysis";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown>
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

const baseAccount: Account = {
  handle: "exampleproject",
  userId: "1234567890",
  displayName: "Example Project",
  bio: "Building the future of decentralized X.",
  verified: false,
  createdAt: "2024-01-01",
  location: null,
};

const baseProfile: Profile = {
  followerCount: 12000,
  followingCount: 300,
  followerRatio: 40,
  followerSpikes: [],
  followerQuality: { score: 60, notes: "Mixed-quality followers; some bot-like accounts." },
  notableFollowers: [],
};

const baseWebsite: Website = {
  url: "https://example.xyz",
  detected: true,
  score: 55,
  design: "Clean but templated.",
  documentation: "Light docs, no whitepaper.",
  roadmap: "Vague roadmap.",
  teamInfo: "Anonymous team.",
  githubLinksOnSite: [],
  notes: "Adequate but unremarkable.",
};

const baseGithub: GitHub = {
  url: null,
  detected: false,
  score: 20,
  activity: "No public repo found.",
  stars: null,
  relevance: "n/a",
  recentCommits: null,
  contributors: null,
  notes: "No GitHub presence detected.",
};

const baseEngagement: Engagement = {
  momentumScore: 50,
  avgLikes: 120,
  avgReposts: 30,
  cadence: "Several posts per day.",
  notes: "Steady but not viral.",
};

const baseTechnicalDepth: TechnicalDepth = {
  score: 40,
  notes: "Marketing-heavy, limited technical substance.",
};

const basePrice: Price = {
  token: null,
  marketCapUsd: null,
  volume24hUsd: null,
  priceUsd: null,
  source: "none",
  notes: "No token detected.",
};

/** Build a complete, valid AnalysisReport for tests / the mock dev runner. */
export function makeReport(overrides: DeepPartial<AnalysisReport> = {}): AnalysisReport {
  return {
    account: { ...baseAccount, ...overrides.account },
    profile: {
      ...baseProfile,
      ...overrides.profile,
      followerQuality: { ...baseProfile.followerQuality, ...overrides.profile?.followerQuality },
    },
    website: { ...baseWebsite, ...overrides.website },
    github: { ...baseGithub, ...overrides.github },
    developers: (overrides.developers as AnalysisReport["developers"]) ?? [],
    engagement: { ...baseEngagement, ...overrides.engagement },
    technicalDepth: { ...baseTechnicalDepth, ...overrides.technicalDepth },
    price: { ...basePrice, ...overrides.price },
    redFlags: (overrides.redFlags as AnalysisReport["redFlags"]) ?? [],
    summary: overrides.summary ?? "An early-stage project with moderate traction and thin technical depth.",
  };
}
