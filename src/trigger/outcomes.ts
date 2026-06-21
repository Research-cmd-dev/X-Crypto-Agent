import { task, schedules, logger } from "@trigger.dev/sdk/v3";
import { supabaseServer } from "@/lib/supabase/server";
import { PriceProvider } from "@/lib/providers/price";
import { mapLimit } from "@/lib/util/fetch";
import { forwardReturn, horizonDays, isMatured } from "@/lib/scoring/outcome";
import type { OutcomeRow } from "@/lib/supabase/types";

/** Minimal price interface so the job is testable with a mock. */
export interface PriceLookup {
  lookup(query: string): Promise<{ priceUsd: number | null; marketCapUsd: number | null }>;
}

/**
 * Refresh forward-return tracking: for every not-yet-matured outcome, re-fetch
 * the token's current price, recompute the return vs. its entry baseline, and
 * freeze it (`matured`) once the horizon is reached. This is the feedback loop
 * that turns past scores into labeled ground truth for backtesting.
 */
export async function runOutcomes(
  price: PriceLookup = new PriceProvider(),
): Promise<{ checked: number; matured: number }> {
  const sb = supabaseServer();
  const { data, error } = await sb.from("outcomes").select("*").eq("matured", false);
  if (error) throw new Error(`Failed to load outcomes: ${error.message}`);

  const rows = (data ?? []) as OutcomeRow[];
  if (rows.length === 0) return { checked: 0, matured: 0 };

  let maturedCount = 0;
  await mapLimit(rows, 4, async (row) => {
    if (!row.token_ref) return;

    let latest: { priceUsd: number | null; marketCapUsd: number | null };
    try {
      latest = await price.lookup(row.token_ref);
    } catch (e) {
      logger.warn("outcome price lookup failed", { token: row.token_ref, error: String(e) });
      return;
    }

    const days = horizonDays(row.baseline_at);
    const matured = isMatured(days);
    const ret = forwardReturn(
      row.baseline_price_usd,
      row.baseline_mcap_usd,
      latest.priceUsd,
      latest.marketCapUsd,
    );
    if (matured) maturedCount++;

    const { error: updErr } = await sb
      .from("outcomes")
      .update({
        last_price_usd: latest.priceUsd,
        last_mcap_usd: latest.marketCapUsd,
        last_checked_at: new Date().toISOString(),
        forward_return: ret ?? row.forward_return,
        horizon_days: days,
        matured,
      })
      .eq("id", row.id);
    if (updErr) logger.warn("outcome update failed", { id: row.id, error: updErr.message });
  });

  logger.info("outcomes updated", { checked: rows.length, matured: maturedCount });
  return { checked: rows.length, matured: maturedCount };
}

/** Manually-triggerable outcome refresh. */
export const outcomesTask = task({
  id: "outcomes",
  maxDuration: 600,
  run: async () => runOutcomes(),
});

/** Scheduled outcome refresh — daily at 03:00 UTC. */
export const outcomesSchedule = schedules.task({
  id: "outcomes-schedule",
  cron: "0 3 * * *",
  run: async () => runOutcomes(),
});
