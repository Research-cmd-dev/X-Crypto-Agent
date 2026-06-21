import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { VerdictBadge } from "@/components/verdict-badge";
import { ScoreBar } from "@/components/score-bar";
import { explainScore } from "@/lib/schema/scoring";
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
  const { candidate, report, score, flags, reportCreatedAt, scoringProfile } = detail;

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
          {(() => {
            const ex = explainScore(report, scoringProfile);
            return (
              <Card>
                <CardHeader>
                  <CardTitle>Why this score</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm">{ex.headline}</p>
                  <div className="space-y-1.5">
                    {ex.contributions.map((c) => (
                      <div key={c.key} className="flex items-center gap-2 text-xs">
                        <span className="w-32 shrink-0 text-muted-foreground">{c.label}</span>
                        <div className="w-40 shrink-0">
                          <ScoreBar score={c.score} showValue={false} />
                        </div>
                        <span className="w-10 text-right tabular-nums">{c.score}</span>
                        <span className="w-24 text-right text-muted-foreground tabular-nums">
                          {(c.weight * 100).toFixed(0)}% → +{c.points}
                        </span>
                      </div>
                    ))}
                  </div>
                  {ex.penalties.length > 0 ? (
                    <div className="border-t pt-2 text-xs">
                      {ex.penalties.map((p, i) => (
                        <div key={`${p.code}-${i}`} className="flex justify-between text-muted-foreground">
                          <span>
                            <Badge variant={SEVERITY_VARIANT[p.severity]}>{p.severity}</Badge>{" "}
                            <span className="font-mono">{p.code}</span>
                          </span>
                          <span className="tabular-nums">−{p.points}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })()}

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

          <Card>
            <CardHeader>
              <CardTitle>
                Smart money{" "}
                <span className="text-muted-foreground">· {report.smartMoney.score}/100</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <p>{report.smartMoney.notes}</p>
            </CardContent>
          </Card>

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
                <Fact
                  k="Engagement rate"
                  v={report.engagement.engagementRate != null ? `${report.engagement.engagementRate}%` : "—"}
                />
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
