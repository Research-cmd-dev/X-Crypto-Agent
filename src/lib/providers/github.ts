import { Octokit } from "@octokit/rest";
import { cached } from "@/lib/cache/store";

export interface RepoMetrics {
  owner: string;
  repo: string;
  url: string;
  description: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string | null;
  /** Approx commits in the last ~90 days on the default branch. */
  recentCommits: number;
  contributors: number;
  topLanguages: string[];
}

/** Parse `owner/repo` (or an org) from a GitHub URL. Returns null if not a repo. */
export function parseGithubUrl(url: string): { owner: string; repo: string | null } | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("github.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    return { owner: parts[0], repo: parts[1] ?? null };
  } catch {
    return null;
  }
}

/** Octokit-backed GitHub client. Works unauthenticated (low rate limit) or with GITHUB_TOKEN. */
export class GithubProvider {
  private readonly octokit: Octokit;

  constructor(token = process.env.GITHUB_TOKEN) {
    this.octokit = new Octokit(token ? { auth: token } : {});
  }

  /** Fetch structured metrics for a single repo (cached 1h). */
  async getRepoMetrics(owner: string, repo: string): Promise<RepoMetrics> {
    return cached("github:repo", `${owner}/${repo}`.toLowerCase(), 3600, () =>
      this.fetchRepoMetrics(owner, repo),
    );
  }

  private async fetchRepoMetrics(owner: string, repo: string): Promise<RepoMetrics> {
    const { data } = await this.octokit.repos.get({ owner, repo });

    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const [commits, contributors, languages] = await Promise.all([
      this.octokit.repos
        .listCommits({ owner, repo, since, per_page: 100 })
        .then((r) => r.data.length)
        .catch(() => 0),
      this.octokit.repos
        .listContributors({ owner, repo, per_page: 100 })
        .then((r) => r.data.length)
        .catch(() => 0),
      this.octokit.repos
        .listLanguages({ owner, repo })
        .then((r) => Object.keys(r.data))
        .catch(() => [] as string[]),
    ]);

    return {
      owner,
      repo,
      url: data.html_url,
      description: data.description,
      stars: data.stargazers_count,
      forks: data.forks_count,
      openIssues: data.open_issues_count,
      pushedAt: data.pushed_at,
      recentCommits: commits,
      contributors,
      topLanguages: languages.slice(0, 5),
    };
  }

  /** Pick the most relevant (most-starred) repo for an org/owner (cached 1h). */
  async getTopRepoForOwner(owner: string): Promise<RepoMetrics | null> {
    return cached("github:top-repo", owner.toLowerCase(), 3600, () =>
      this.fetchTopRepoForOwner(owner),
    );
  }

  private async fetchTopRepoForOwner(owner: string): Promise<RepoMetrics | null> {
    const { data } = await this.octokit.repos
      .listForUser({ username: owner, sort: "updated", per_page: 100 })
      .catch(() => ({ data: [] as { name: string; stargazers_count: number }[] }));
    if (data.length === 0) return null;
    const top = [...data].sort(
      (a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0),
    )[0];
    return this.getRepoMetrics(owner, top.name);
  }
}
