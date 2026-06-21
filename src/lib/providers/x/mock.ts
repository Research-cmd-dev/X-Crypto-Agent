import type {
  XProvider,
  XUser,
  XTweet,
  SearchOptions,
} from "@/lib/providers/x/types";

/**
 * Deterministic in-memory X provider for tests and offline development.
 * Seed it with users/tweets, or use the default sample.
 */
export class MockXProvider implements XProvider {
  private usersByHandle = new Map<string, XUser>();
  private usersById = new Map<string, XUser>();
  private timelines = new Map<string, XTweet[]>();
  private searchResults: XTweet[] = [];
  private followers = new Map<string, XUser[]>();

  constructor(seed?: {
    users?: XUser[];
    timelines?: Record<string, XTweet[]>;
    searchResults?: XTweet[];
    followers?: Record<string, XUser[]>;
  }) {
    const users = seed?.users ?? defaultUsers();
    for (const u of users) {
      this.usersByHandle.set(u.username.toLowerCase(), u);
      this.usersById.set(u.id, u);
    }
    for (const [id, tl] of Object.entries(seed?.timelines ?? defaultTimelines()))
      this.timelines.set(id, tl);
    this.searchResults = seed?.searchResults ?? defaultSearch();
    for (const [id, f] of Object.entries(seed?.followers ?? defaultFollowers()))
      this.followers.set(id, f);
  }

  async getUserByHandle(handle: string): Promise<XUser | null> {
    return this.usersByHandle.get(handle.replace(/^@/, "").toLowerCase()) ?? null;
  }
  async getUserById(id: string): Promise<XUser | null> {
    return this.usersById.get(id) ?? null;
  }
  async getUserTimeline(userId: string, opts?: SearchOptions): Promise<XTweet[]> {
    return (this.timelines.get(userId) ?? []).slice(0, opts?.maxResults ?? 25);
  }
  async searchRecent(_query: string, opts?: SearchOptions): Promise<XTweet[]> {
    return this.searchResults.slice(0, opts?.maxResults ?? 25);
  }
  async getFollowersSample(userId: string, opts?: SearchOptions): Promise<XUser[]> {
    return (this.followers.get(userId) ?? []).slice(0, opts?.maxResults ?? 50);
  }
}

function mkUser(p: Partial<XUser> & Pick<XUser, "id" | "username" | "name">): XUser {
  return {
    description: null,
    verified: false,
    createdAt: "2024-06-01",
    location: null,
    followersCount: 0,
    followingCount: 0,
    tweetCount: 0,
    urls: [],
    profileImageUrl: null,
    ...p,
  };
}

function defaultUsers(): XUser[] {
  return [
    mkUser({
      id: "1001",
      username: "exampledefi",
      name: "ExampleDeFi",
      description: "On-chain perps. Backed by builders. https://exampledefi.xyz",
      followersCount: 48000,
      followingCount: 210,
      tweetCount: 1200,
      urls: ["https://exampledefi.xyz", "https://github.com/exampledefi"],
    }),
    mkUser({ id: "9001", username: "nvidia", name: "NVIDIA", verified: true, followersCount: 3_000_000 }),
    mkUser({ id: "9002", username: "AMD", name: "AMD", verified: true, followersCount: 2_000_000 }),
  ];
}

function defaultTimelines(): Record<string, XTweet[]> {
  return {
    "1001": [
      {
        id: "t1",
        authorId: "1001",
        authorUsername: "exampledefi",
        text: "Mainnet is live. Audited by a top firm. Docs: https://exampledefi.xyz/docs",
        createdAt: "2025-06-10",
        likeCount: 900,
        repostCount: 220,
        replyCount: 80,
        urls: ["https://exampledefi.xyz/docs"],
      },
    ],
  };
}

function defaultSearch(): XTweet[] {
  return [
    {
      id: "s1",
      authorId: "1001",
      authorUsername: "exampledefi",
      text: "New crypto project launching: $EXDF perps DEX. https://exampledefi.xyz",
      createdAt: "2025-06-11",
      likeCount: 120,
      repostCount: 35,
      replyCount: 12,
      urls: ["https://exampledefi.xyz"],
    },
  ];
}

function defaultFollowers(): Record<string, XUser[]> {
  return {
    "1001": [
      mkUser({ id: "9001", username: "nvidia", name: "NVIDIA", verified: true, followersCount: 3_000_000 }),
      mkUser({ id: "5005", username: "randomuser", name: "Random User", followersCount: 12 }),
    ],
  };
}
