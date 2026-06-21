import { serverEnv } from "@/lib/env";
import type {
  XProvider,
  XUser,
  XTweet,
  SearchOptions,
} from "@/lib/providers/x/types";

const BASE = "https://api.x.com/2";

const USER_FIELDS =
  "description,verified,created_at,location,public_metrics,entities,profile_image_url";
const TWEET_FIELDS = "created_at,public_metrics,entities,author_id";

interface RawUser {
  id: string;
  username: string;
  name: string;
  description?: string;
  verified?: boolean;
  created_at?: string;
  location?: string;
  public_metrics?: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
  };
  entities?: { url?: { urls?: { expanded_url?: string }[] } };
  profile_image_url?: string;
}

interface RawTweet {
  id: string;
  author_id?: string;
  text: string;
  created_at?: string;
  public_metrics?: {
    like_count: number;
    retweet_count: number;
    reply_count: number;
  };
  entities?: { urls?: { expanded_url?: string }[] };
}

function expandedUrls(entities: RawTweet["entities"]): string[] {
  return (entities?.urls ?? [])
    .map((u) => u.expanded_url)
    .filter((u): u is string => Boolean(u));
}

function toUser(raw: RawUser): XUser {
  return {
    id: raw.id,
    username: raw.username,
    name: raw.name,
    description: raw.description ?? null,
    verified: raw.verified ?? false,
    createdAt: raw.created_at ?? null,
    location: raw.location ?? null,
    followersCount: raw.public_metrics?.followers_count ?? 0,
    followingCount: raw.public_metrics?.following_count ?? 0,
    tweetCount: raw.public_metrics?.tweet_count ?? 0,
    urls: (raw.entities?.url?.urls ?? [])
      .map((u) => u.expanded_url)
      .filter((u): u is string => Boolean(u)),
    profileImageUrl: raw.profile_image_url ?? null,
  };
}

function toTweet(raw: RawTweet, usernameById?: Map<string, string>): XTweet {
  return {
    id: raw.id,
    authorId: raw.author_id ?? "",
    authorUsername: raw.author_id ? (usernameById?.get(raw.author_id) ?? null) : null,
    text: raw.text,
    createdAt: raw.created_at ?? null,
    likeCount: raw.public_metrics?.like_count ?? 0,
    repostCount: raw.public_metrics?.retweet_count ?? 0,
    replyCount: raw.public_metrics?.reply_count ?? 0,
    urls: expandedUrls(raw.entities),
  };
}

/**
 * Thin X API v2 client. Requires X_API_BEARER_TOKEN (a paid X API plan).
 * Hardening (rate-limit backoff, pagination beyond one page, caching) is left
 * as a clearly-marked extension point — this implements the happy path used by
 * discovery + the X analyzer agent.
 */
export class XApiProvider implements XProvider {
  private readonly token: string;

  constructor(token = serverEnv().X_API_BEARER_TOKEN) {
    this.token = token;
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`X API ${res.status} on ${path}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async getUserByHandle(handle: string): Promise<XUser | null> {
    const data = await this.get<{ data?: RawUser }>(
      `/users/by/username/${encodeURIComponent(handle.replace(/^@/, ""))}`,
      { "user.fields": USER_FIELDS },
    );
    return data.data ? toUser(data.data) : null;
  }

  async getUserById(id: string): Promise<XUser | null> {
    const data = await this.get<{ data?: RawUser }>(`/users/${id}`, {
      "user.fields": USER_FIELDS,
    });
    return data.data ? toUser(data.data) : null;
  }

  async getUserTimeline(userId: string, opts?: SearchOptions): Promise<XTweet[]> {
    const data = await this.get<{ data?: RawTweet[] }>(`/users/${userId}/tweets`, {
      "tweet.fields": TWEET_FIELDS,
      max_results: String(Math.min(opts?.maxResults ?? 25, 100)),
    });
    return (data.data ?? []).map((t) => toTweet(t));
  }

  async searchRecent(query: string, opts?: SearchOptions): Promise<XTweet[]> {
    const data = await this.get<{
      data?: RawTweet[];
      includes?: { users?: RawUser[] };
    }>(`/tweets/search/recent`, {
      query,
      "tweet.fields": TWEET_FIELDS,
      expansions: "author_id",
      "user.fields": "username",
      max_results: String(Math.min(opts?.maxResults ?? 25, 100)),
    });
    const usernameById = new Map(
      (data.includes?.users ?? []).map((u) => [u.id, u.username]),
    );
    return (data.data ?? []).map((t) => toTweet(t, usernameById));
  }

  async getFollowersSample(userId: string, opts?: SearchOptions): Promise<XUser[]> {
    const data = await this.get<{ data?: RawUser[] }>(`/users/${userId}/followers`, {
      "user.fields": USER_FIELDS,
      max_results: String(Math.min(opts?.maxResults ?? 50, 1000)),
    });
    return (data.data ?? []).map(toUser);
  }
}
