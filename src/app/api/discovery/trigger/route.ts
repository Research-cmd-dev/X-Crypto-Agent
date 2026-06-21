import { NextResponse } from "next/server";
import { discoveryTask } from "@/trigger/discovery";

export const dynamic = "force-dynamic";

/**
 * Manually kick off a discovery scan. Requires TRIGGER_SECRET_KEY to be set so
 * the SDK can enqueue the run. Returns the Trigger.dev run handle id.
 */
export async function POST() {
  try {
    const handle = await discoveryTask.trigger();
    return NextResponse.json({ ok: true, runId: handle.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
