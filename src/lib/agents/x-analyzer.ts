import type { Agent, AgentContext, AgentSlice } from "@/lib/agents/types";
import type { XTweet, XUser } from "@/lib/providers/x";
import { xAnalyzerOutputSchema } from "@/lib/schema/analysis";
import { researchText } from "@/lib/anthropic/research";
import { parseStructured } from "@/lib/anthropic/structured";
import { X_ANALYZER_SYSTEM } from "@/lib/prompts/x-analyzer.system";
import {
  extractUrls,
  firstWebsiteUrl,
  firstGithubUrl,
  githubOwnerFromUrl,
  extractMentions,
  extractContractAddress,
} from "@/lib/extract";

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

interface Detected {
  websiteUrl: string | null;
  githubUrl: string | null;
  githubOwner: string | null;
  contractAddress: string | null;
  mentions: string[];
}

/** Deterministically pull hard signals from the bio + posts (not just the profile link). */
function detectSignals(user: XUser, tweets: XTweet[]): Detected {
  const bio = user.description ?? "";
  const postText = tweets.map((t) => t.text).join("\n");
  const textBlob = `${bio}\n${postText}`;
  // Structured (already-expanded) URLs from the profile + every post, then any
  // raw/bare URLs mentioned in the bio/post text.
  const urls = [
    ...user.urls,
    ...tweets.flatMap((t) => t.urls),
    ...extractUrls(textBlob),
  ];
  const githubUrl = firstGithubUrl(urls);
  return {
    websiteUrl: firstWebsiteUrl(urls),
    githubUrl,
    githubOwner: githubOwnerFromUrl(githubUrl),
    contractAddress: extractContractAddress(textBlob),
    mentions: extractMentions(postText),
  };
}

function signalsBlock(d: Detected): string {
  return `SIGNALS EXTRACTED FROM BIO + POSTS (deterministic):
website: ${d.websiteUrl ?? "(none found)"}
github: ${d.githubUrl ?? "(none found)"}${d.githubOwner ? ` (owner/dev candidate: ${d.githubOwner})` : ""}
token contract address: ${d.contractAddress ?? "(none found)"}
accounts mentioned in posts (dev/collaborator candidates): ${d.mentions.map((m) => `@${m}`).join(", ") || "(none)"}`;
}

function evidence(user: XUser, tweets: XTweet[], followers: XUser[]): string {
  const tweetLines = tweets
    .slice(0, 15)
    .map(
      (t) =>
        `- (${t.likeCount}♥ ${t.repostCount}↻ ${t.replyCount}💬) ${t.text.replace(/\s+/g, " ").slice(0, 220)}`,
    )
    .join("\n");
  const followerLines = followers
    .slice(0, 40)
    .map(
      (f) =>
        `- @${f.username} (${f.name})${f.verified ? " [verified]" : ""} — ${f.followersCount} followers`,
    )
    .join("\n");

  return `ACCOUNT (real X API data):
handle: @${user.username}
name: ${user.name}
userId: ${user.id}
bio: ${user.description ?? "(none)"}
verified: ${user.verified}
created: ${user.createdAt ?? "unknown"}
location: ${user.location ?? "unknown"}
followers: ${user.followersCount}
following: ${user.followingCount}
tweets: ${user.tweetCount}
profile links: ${user.urls.join(", ") || "(none)"}

RECENT TWEETS:
${tweetLines || "(none available)"}

FOLLOWER SAMPLE:
${followerLines || "(none available)"}`;
}

export const xAnalyzerAgent: Agent = {
  name: "x-analyzer",

  async run(ctx: AgentContext): Promise<AgentSlice> {
    const { providers, candidate, log } = ctx;

    // 1. Resolve the X profile (hard data).
    let user = ctx.xUser;
    if (!user) {
      user = candidate.xUserId
        ? await providers.x.getUserById(candidate.xUserId)
        : await providers.x.getUserByHandle(candidate.handle);
    }

    if (!user) {
      log("x profile unresolved", { handle: candidate.handle });
      return {
        redFlags: [
          {
            severity: "high",
            code: "x_profile_unresolved",
            message: `Could not resolve X profile @${candidate.handle}.`,
          },
        ],
        summary: `X profile @${candidate.handle} could not be resolved.`,
      };
    }
    ctx.xUser = user;

    // 2. Gather timeline + follower sample.
    const [tweets, followers] = await Promise.all([
      providers.x.getUserTimeline(user.id, { maxResults: 25 }).catch(() => []),
      providers.x.getFollowersSample(user.id, { maxResults: 50 }).catch(() => []),
    ]);

    // 2b. Deterministically pull website / github / contract / dev candidates
    // from the bio + posts, and set hints NOW so downstream agents (website,
    // github, price) still work even if the LLM steps below fail.
    const detected = detectSignals(user, tweets);
    ctx.hints.websiteUrl = detected.websiteUrl;
    ctx.hints.githubUrl = detected.githubUrl;
    ctx.hints.contractAddress = detected.contractAddress;
    log("x-analyzer signals", {
      website: detected.websiteUrl,
      github: detected.githubUrl,
      contract: detected.contractAddress,
      mentions: detected.mentions.length,
    });

    const ev = `${evidence(user, tweets, followers)}

${signalsBlock(detected)}`;

    // 3. Research enrichment (notable followers, website, github, devs).
    const research = await researchText({
      system: X_ANALYZER_SYSTEM,
      prompt: `Research this crypto X account. Confirm its official website and GitHub,
identify any associated developer accounts (start from the extracted signals
below — the GitHub owner and accounts mentioned in posts are strong candidates),
and any notable/high-signal followers or backers. Be concise and cite findings.

${ev}`,
      maxUses: 4,
    }).catch((e) => {
      log("x-analyzer research failed", { error: String(e) });
      return "";
    });

    // 4. Structured synthesis.
    const out = await parseStructured({
      agent: "x-analyzer",
      schema: xAnalyzerOutputSchema,
      system: X_ANALYZER_SYSTEM,
      prompt: `${ev}

WEB RESEARCH EVIDENCE:
${research || "(no additional research)"}

Produce the structured analysis now. Use the extracted signals for websiteUrl,
githubUrl, and contractAddress unless research clearly contradicts them.`,
      maxTokens: 4096,
    });

    // 5. Override hard metrics with real X data; prefer LLM hints, fall back to
    // the deterministic signals from the bio/posts.
    const avgLikes = avg(tweets.map((t) => t.likeCount));
    const avgReposts = avg(tweets.map((t) => t.repostCount));

    ctx.hints.websiteUrl = out.websiteUrl ?? detected.websiteUrl;
    ctx.hints.githubUrl = out.githubUrl ?? detected.githubUrl;
    ctx.hints.contractAddress = out.contractAddress ?? detected.contractAddress;

    return {
      account: {
        handle: user.username,
        userId: user.id,
        displayName: user.name,
        bio: user.description,
        verified: user.verified,
        createdAt: user.createdAt,
        location: user.location,
      },
      profile: {
        ...out.profile,
        followerCount: user.followersCount,
        followingCount: user.followingCount,
        followerRatio:
          user.followingCount > 0
            ? Math.round((user.followersCount / user.followingCount) * 10) / 10
            : null,
      },
      engagement: {
        ...out.engagement,
        avgLikes: avgLikes ?? out.engagement.avgLikes,
        avgReposts: avgReposts ?? out.engagement.avgReposts,
      },
      developers: out.developers,
      technicalDepth: out.technicalDepth,
      redFlags: out.redFlags,
      summary: out.summary,
    };
  },
};
