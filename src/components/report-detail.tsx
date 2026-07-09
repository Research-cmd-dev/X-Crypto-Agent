import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { VerdictBadge } from "@/components/verdict-badge";
import { ScoreBar } from "@/components/score-bar";
import type { CandidateDetail } from "@/lib/data/candidates";
import type { FlagSeverity } from "@/lib/supabase/types";

function money(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", style: "currency", currency: "USD" }).format(n);
}

const SEVERITY_VARIANT: Record<FlagSeverity, "destructive" | "warning" | "secondary"> = {
  high: "destructive",
  med: "warning",
  low: "secondary",
};

export function ReportDetail({ detail }: { detail: CandidateDetail }) {
  const { candidate, report, score, flags, reportCreatedAt } = detail;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link href="/dashboard" className="text-sm text-muted-foreground hover:underline">
        ← Back to dashboard
      </Link>

      <header className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {candidate.display_name ?? candidate.handle}
          </h1>
          <a
            href={`https://x.com/${candidate.handle}`}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-muted-foreground hover:underline"
          >
            @{candidate.handle}
          </a>
          {candidate.token_address ? (
            <span className="text-xs text-muted-foreground"> · {candidate.token_address}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <VerdictBadge verdict={score?.verdict ?? null} />
          {score ? <div className="text-3xl font-bold tabular-nums">{score.overall}</div> : null}
        </div>
      </header>

      {!report ? (
        <p className="mt-8 text-muted-foreground">
          This candidate has not been analyzed yet (status: {candidate.status}).
        </p>
      ) : (
        <div className="mt-6 space-y-6">
          {score ? (
            <Card>
              <CardHeader>
                <CardTitle>Score breakdown</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <ScoreBar label="Profile" score={score.profile} />
                <ScoreBar label="Website" score={score.website} />
                <ScoreBar label="GitHub" score={score.github} />
                <ScoreBar label="Engagement" score={score.engagement} />
                <ScoreBar label="Technical depth" score={score.technical_depth} />
                <ScoreBar label="Price/liquidity" score={score.price} />
                <ScoreBar label="Onchain" score={score.onchain ?? 0} />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{report.summary || "—"}</p>
            </CardContent>
          </Card>

          {flags.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Red flags</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {flags.map((f) => (
                  <div key={f.id} className="flex items-start gap-2 text-sm">
                    <Badge variant={SEVERITY_VARIANT[f.severity]}>{f.severity}</Badge>
                    <div>
                      <span className="font-mono text-xs text-muted-foreground">{f.code}</span>{" "}
                      {f.message}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Profile &amp; followers</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Fact k="Followers" v={report.profile.followerCount?.toLocaleString() ?? "—"} />
                <Fact k="Following" v={report.profile.followingCount?.toLocaleString() ?? "—"} />
                <Fact k="Ratio" v={report.profile.followerRatio?.toString() ?? "—"} />
                <Fact k="Follower quality" v={`${report.profile.followerQuality.score}/100`} />
                <p className="text-muted-foreground">{report.profile.followerQuality.notes}</p>
                {report.profile.notableFollowers.length > 0 ? (
                  <div className="pt-2">
                    <div className="mb-1 font-medium">Notable followers</div>
                    <ul className="list-inside list-disc text-muted-foreground">
                      {report.profile.notableFollowers.map((nf) => (
                        <li key={nf.handle}>
                          @{nf.handle} — {nf.why}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Engagement &amp; price</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Fact k="Momentum" v={`${report.engagement.momentumScore}/100`} />
                <Fact k="Avg likes" v={report.engagement.avgLikes?.toLocaleString() ?? "—"} />
                <Fact k="Avg reposts" v={report.engagement.avgReposts?.toLocaleString() ?? "—"} />
                <p className="text-muted-foreground">{report.engagement.notes}</p>
                <div className="pt-2">
                  <Fact k="Token" v={report.price.token ?? "—"} />
                  <Fact k="Market cap" v={money(report.price.marketCapUsd)} />
                  <Fact k="24h volume" v={money(report.price.volume24hUsd)} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Onchain {report.onchain?.holderCount != null ? `· ${report.onchain.holderCount.toLocaleString()} holders` : ""}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Fact k="Holders" v={report.onchain?.holderCount?.toLocaleString() ?? "—"} />
                <Fact k="Traders 24h" v={report.onchain?.traders24h?.toLocaleString() ?? "—"} />
                <Fact k="Trades 24h" v={report.onchain?.trades24h?.toLocaleString() ?? "—"} />
                <Fact k="First trade" v={report.onchain?.firstTradeAt ? new Date(report.onchain.firstTradeAt).toLocaleString() : "—"} />
                <Fact k="Smart money" v={report.onchain?.smartMoney ?? "—"} />
                <Fact k="Source" v={report.onchain?.source ?? "—"} />
                <p className="text-muted-foreground">{report.onchain?.notes || ""}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Website {report.website.detected ? `· ${report.website.score}/100` : ""}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {report.website.url ? (
                  <a href={report.website.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    {report.website.url}
                  </a>
                ) : (
                  <p className="text-muted-foreground">No website detected.</p>
                )}
                <Fact k="Design" v={report.website.design} />
                <Fact k="Docs" v={report.website.documentation} />
                <Fact k="Roadmap" v={report.website.roadmap} />
                <Fact k="Team" v={report.website.teamInfo} />
                <p className="text-muted-foreground">{report.website.notes}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>GitHub {report.github.detected ? `· ${report.github.score}/100` : ""}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {report.github.url ? (
                  <a href={report.github.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    {report.github.url}
                  </a>
                ) : (
                  <p className="text-muted-foreground">No GitHub detected.</p>
                )}
                <Fact k="Stars" v={report.github.stars?.toLocaleString() ?? "—"} />
                <Fact k="Recent commits" v={report.github.recentCommits?.toString() ?? "—"} />
                <Fact k="Contributors" v={report.github.contributors?.toString() ?? "—"} />
                <Fact k="Activity" v={report.github.activity} />
                <p className="text-muted-foreground">{report.github.notes}</p>
              </CardContent>
            </Card>
          </div>

          {report.developers.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Associated developers</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {report.developers.map((d, i) => (
                  <div key={`${d.handle ?? d.githubUrl ?? i}`} className="border-b pb-2 last:border-0">
                    <div className="font-medium">
                      {d.handle ? `@${d.handle}` : d.name ?? "Unknown"}{" "}
                      {d.githubUrl ? (
                        <a href={d.githubUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                          {d.githubUrl}
                        </a>
                      ) : null}
                    </div>
                    <p className="text-muted-foreground">{d.qualityNote}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {reportCreatedAt ? (
            <p className="text-xs text-muted-foreground">
              Analyzed {new Date(reportCreatedAt).toLocaleString()}
            </p>
          ) : null}
        </div>
      )}
    </main>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right">{v}</span>
    </div>
  );
}
