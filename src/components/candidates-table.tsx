"use client";

import * as React from "react";
import Link from "next/link";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { VerdictBadge } from "@/components/verdict-badge";
import { ScoreBar } from "@/components/score-bar";
import type { Verdict } from "@/lib/supabase/types";
import type { CandidateListItem } from "@/lib/data/candidates";

type Filter = "All" | "New" | Verdict;

/** "New" = discovered but not yet scored (awaiting a verdict). */
function isNew(c: CandidateListItem): boolean {
  return !c.score;
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 1,
  }).format(n);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function CandidatesTable({ candidates }: { candidates: CandidateListItem[] }) {
  const [filter, setFilter] = React.useState<Filter>("All");
  const [query, setQuery] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [runMsg, setRunMsg] = React.useState<string | null>(null);

  const counts = React.useMemo(() => {
    const c = { All: candidates.length, New: 0, High: 0, Monitor: 0, Avoid: 0 };
    for (const cand of candidates) {
      if (isNew(cand)) c.New++;
      if (cand.score?.verdict) c[cand.score.verdict]++;
    }
    return c;
  }, [candidates]);

  const rows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates.filter((c) => {
      if (filter === "New" && !isNew(c)) return false;
      if (filter !== "All" && filter !== "New" && c.score?.verdict !== filter) return false;
      if (!q) return true;
      return (
        c.handle.toLowerCase().includes(q) ||
        (c.display_name?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [candidates, filter, query]);

  async function runDiscovery() {
    setRunning(true);
    setRunMsg(null);
    try {
      const res = await fetch("/api/discovery/trigger", { method: "POST" });
      const json = (await res.json()) as { ok: boolean; runId?: string; error?: string };
      setRunMsg(json.ok ? `Discovery started (run ${json.runId}).` : `Failed: ${json.error}`);
    } catch (e) {
      setRunMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList>
            {(["All", "New", "High", "Monitor", "Avoid"] as Filter[]).map((f) => (
              <TabsTrigger key={f} value={f}>
                {f} <span className="ml-1 text-muted-foreground">({counts[f]})</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Search handle…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-48"
          />
          <Button onClick={runDiscovery} disabled={running} size="sm">
            {running ? "Starting…" : "Run discovery"}
          </Button>
        </div>
      </div>

      {runMsg ? <p className="text-sm text-muted-foreground">{runMsg}</p> : null}

      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead className="w-28">Verdict</TableHead>
              <TableHead className="w-56">Score</TableHead>
              <TableHead className="w-44">Alpha signals</TableHead>
              <TableHead className="w-24">Market cap</TableHead>
              <TableHead className="w-24">Discovered</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  No candidates yet. Run discovery to start scouting.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((c) => (
                <TableRow key={c.id} className="cursor-pointer">
                  <TableCell>
                    <Link href={`/dashboard/${c.id}`} className="block">
                      <div className="font-medium">{c.display_name ?? c.handle}</div>
                      <div className="text-xs text-muted-foreground">@{c.handle}</div>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/dashboard/${c.id}`}>
                      <VerdictBadge verdict={c.score?.verdict ?? null} />
                    </Link>
                  </TableCell>
                  <TableCell>
                    {c.score ? (
                      <ScoreBar score={c.score.overall} />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {c.score ? (
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={c.score.smart_money >= 70 ? "success" : "secondary"}>
                          SM {c.score.smart_money}
                        </Badge>
                        {c.engagementRate != null ? (
                          <Badge variant="secondary">ER {c.engagementRate}%</Badge>
                        ) : null}
                        {c.notableFollowerCount > 0 ? (
                          <Badge variant="secondary">{c.notableFollowerCount}★ notable</Badge>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{c.status}</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{fmtMoney(c.marketCapUsd)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {fmtDate(c.discovered_at)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
