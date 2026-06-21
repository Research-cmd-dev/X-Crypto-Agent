// Domain types + provider interface for X (Twitter) data.
// The interface lets the real X API v2 client (`x-api.ts`) be swapped for the
// `mock.ts` provider in tests / offline development.

export interface XUser {
  id: string;
  username: string; // handle without @
  name: string;
  description: string | null;
  verified: boolean;
  createdAt: string | null;
  location: string | null;
  followersCount: number;
  followingCount: number;
  tweetCount: number;
  /** URLs expanded from the profile (website, links). */
  urls: string[];
  profileImageUrl: string | null;
}

export interface XTweet {
  id: string;
  authorId: string;
  authorUsername: string | null;
  text: string;
  createdAt: string | null;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  /** URLs expanded from the tweet body. */
  urls: string[];
}

export interface SearchOptions {
  maxResults?: number;
}

export interface XProvider {
  /** Resolve a profile by handle (without @). Returns null if not found. */
  getUserByHandle(handle: string): Promise<XUser | null>;
  /** Resolve a profile by numeric id. Returns null if not found. */
  getUserById(id: string): Promise<XUser | null>;
  /** Recent tweets from a user's timeline. */
  getUserTimeline(userId: string, opts?: SearchOptions): Promise<XTweet[]>;
  /** Recent-search across X (used by query-based discovery). */
  searchRecent(query: string, opts?: SearchOptions): Promise<XTweet[]>;
  /** A sample of a user's followers (used for notable-follower detection). */
  getFollowersSample(userId: string, opts?: SearchOptions): Promise<XUser[]>;
}
