import { listCandidatesWithScores, type CandidateListItem } from "@/lib/data/candidates";
import { CandidatesTable } from "@/components/candidates-table";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let candidates: CandidateListItem[] = [];
  let error: string | null = null;
  try {
    candidates = await listCandidatesWithScores();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Crypto Scout Swarm</h1>
        <p className="text-sm text-muted-foreground">
          Autonomous discovery, deep research, and scoring of new crypto projects on X.
        </p>
      </header>

      {error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium text-destructive">Could not load candidates.</p>
          <p className="mt-1 text-muted-foreground">{error}</p>
          <p className="mt-2 text-muted-foreground">
            Check your Supabase env vars and that <code>supabase/schema.sql</code> has been applied.
          </p>
        </div>
      ) : (
        <CandidatesTable candidates={candidates} />
      )}
    </main>
  );
}
