import { NextResponse, type NextRequest } from "next/server";
import { listCandidatesWithScores } from "@/lib/data/candidates";
import type { Verdict } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

const VERDICTS = new Set(["High", "Monitor", "Avoid"]);

export async function GET(req: NextRequest) {
  try {
    const verdictParam = req.nextUrl.searchParams.get("verdict");
    const verdict = verdictParam && VERDICTS.has(verdictParam) ? (verdictParam as Verdict) : undefined;
    const candidates = await listCandidatesWithScores({ verdict });
    return NextResponse.json({ candidates });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
