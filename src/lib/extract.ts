/**
 * Lightweight, deterministic signal extraction from an X account's bio + post
 * text: website URLs, GitHub links/owners, @mention dev candidates, and the
 * on-chain token contract address (Solana / pump.fun). These hard signals seed
 * the agent hints so the website / github / price agents work off real data
 * pulled from the account — not just the single profile-link field.
 */

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;
// Bare domains (no scheme) e.g. "c0mpute.ai" — conservative curated TLD list.
const BARE_DOMAIN_RE =
  /\b((?:[a-z0-9-]+\.)+(?:com|io|xyz|ai|app|so|fi|org|net|gg|dev|fun|finance|tech|co|fund|capital|wtf|build|sh))\b/gi;
const MENTION_RE = /(?:^|[^\w@/])@([A-Za-z0-9_]{2,15})\b/g;
// Solana base58 mint (32-44 chars; base58 alphabet excludes 0 O I l).
const SOL_ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/** Hosts that are never the project's own website / a developer link. */
const EXCLUDED_HOST_RE =
  /(?:^|\.)(x\.com|twitter\.com|t\.co|github\.com|pump\.fun|dexscreener\.com|birdeye\.so|twimg\.com|youtube\.com|youtu\.be|t\.me|discord\.gg|discord\.com|medium\.com|linktr\.ee)$/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** All distinct URLs found in free text (explicit http(s) + bare domains). */
export function extractUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(URL_RE)) out.add(m[0].replace(/[).,]+$/, ""));
  for (const m of text.matchAll(BARE_DOMAIN_RE)) {
    const host = m[1].toLowerCase();
    if (!/\.(png|jpe?g|gif|svg|webp|mp4)$/i.test(host)) out.add(`https://${host}`);
  }
  return [...out];
}

/** First URL that looks like the project's own website. */
export function firstWebsiteUrl(urls: string[]): string | null {
  return (
    urls.find((u) => {
      const h = hostOf(u);
      return h != null && !EXCLUDED_HOST_RE.test(h);
    }) ?? null
  );
}

/** First github.com URL. */
export function firstGithubUrl(urls: string[]): string | null {
  return urls.find((u) => /(^|\.)github\.com$/i.test(hostOf(u) ?? "")) ?? null;
}

/** The owner/org segment of a github URL (a developer candidate). */
export function githubOwnerFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const h = hostOf(url);
  if (!h || !/(^|\.)github\.com$/i.test(h)) return null;
  try {
    const owner = new URL(url).pathname.split("/").filter(Boolean)[0] ?? null;
    return owner && !/^(orgs|sponsors|topics|search)$/i.test(owner) ? owner : null;
  } catch {
    return null;
  }
}

/** The handle from an x.com / twitter.com profile URL (e.g. a token's social link). */
export function handleFromXUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/(?:x\.com|twitter\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?:[/?]|$)/i);
  if (!m) return null;
  const handle = m[1];
  return /^(i|intent|home|share|hashtag|search|explore|messages)$/i.test(handle) ? null : handle;
}

/** Distinct @mentions in post text (developer / collaborator candidates). */
export function extractMentions(text: string | null | undefined, limit = 12): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    const h = m[1];
    if (!seen.has(h.toLowerCase())) {
      seen.add(h.toLowerCase());
      out.push(h);
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The token contract address from bio/post text. Prefers a pump.fun mint (ends
 * in "pump"); otherwise an address explicitly labelled CA / contract / mint.
 */
export function extractContractAddress(text: string | null | undefined): string | null {
  if (!text) return null;
  const all = text.match(SOL_ADDR_RE) ?? [];
  const pump = all.find((a) => /pump$/i.test(a));
  if (pump) return pump;
  const labelled = text.match(
    /(?:\bCA\b|contract|mint|token)\s*[:=]?\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i,
  );
  return labelled?.[1] ?? null;
}
