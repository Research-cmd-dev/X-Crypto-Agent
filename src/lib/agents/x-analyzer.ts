import type { Agent, AgentContext, AgentSlice } from "@/lib/agents/types";
import type { XTweet, XUser } from "@/lib/providers/x";
import { xAnalyzerOutputSchema } from "@/lib/schema/analysis";
import { researchText } from "@/lib/anthropic/research";
import { parseStructured } from "@/lib/anthropic/structured";
import { X_ANALYZER_SYSTEM } from "@/lib/prompts/x-analyzer.system";

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function firstGithubUrl(urls: string[]): string | null {
  return urls.find((u) => /github\.com/i.test(u)) ?? null;
}
function firstWebsiteUrl(urls: string[]): string | null {
  return urls.find((u) => !/github\.com|twitter\.com|x\.com|t\.co/i.test(u)) ?? null;
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

    // 3. Research enrichment (notable followers, website, github, devs).
    const research = await researchText({
      system: X_ANALYZER_SYSTEM,
      prompt: `Research this crypto X account. Identify its official website and GitHub,
any notable/high-signal followers or backers, and any associated developer
accounts. Be concise and cite what you find.

${evidence(user, tweets, followers)}`,
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
      prompt: `${evidence(user, tweets, followers)}

WEB RESEARCH EVIDENCE:
${research || "(no additional research)"}

Produce the structured analysis now.`,
      maxTokens: 4096,
    });

    // 5. Override hard metrics with real X data; set hints for downstream agents.
    const avgLikes = avg(tweets.map((t) => t.likeCount));
    const avgReposts = avg(tweets.map((t) => t.repostCount));
    const avgEngagement = avg(
      tweets.map((t) => t.likeCount + t.repostCount + t.replyCount),
    );
    // Engagement rate: avg total engagement per post as a % of followers.
    // For low-float gems, a high rate on a small account signals a real, sticky
    // community — a core alpha tell.
    const engagementRate =
      avgEngagement != null && user.followersCount > 0
        ? Math.round((avgEngagement / user.followersCount) * 10000) / 100
        : null;
    const profileUrls = [
      ...user.urls,
      ...tweets.flatMap((t) => t.urls),
    ];

    ctx.hints.websiteUrl = out.websiteUrl ?? firstWebsiteUrl(profileUrls);
    ctx.hints.githubUrl = out.githubUrl ?? firstGithubUrl(profileUrls);

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
        engagementRate: engagementRate ?? out.engagement.engagementRate,
      },
      smartMoney: out.smartMoney,
      developers: out.developers,
      technicalDepth: out.technicalDepth,
      redFlags: out.redFlags,
      summary: out.summary,
    };
  },
};
