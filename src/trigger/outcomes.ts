import { task, schedules, logger } from "@trigger.dev/sdk/v3";
import { supabaseServer } from "@/lib/supabase/server";
import { PriceProvider } from "@/lib/providers/price";
import { getGmgnProvider } from "@/lib/providers/gmgn";
import { mapLimit } from "@/lib/util/fetch";
import { forwardReturn, horizonDays, isMatured } from "@/lib/scoring/outcome";
import {
  currentPriceForOutcome,
  type CurrentPrice,
  type MaturationSources,
} from "@/lib/scoring/maturation";
import type { OutcomeRow } from "@/lib/supabase/types";

function defaultSources(): MaturationSources {
  return { coingecko: new PriceProvider(), gmgn: getGmgnProvider() };
}

/**
 * Refresh forward-return tracking: for every not-yet-matured outcome, re-fetch
 * the token's current price (routed by type), recompute the return vs. its entry
 * baseline, append a price/volume snapshot to the time series, and freeze it
 * (`matured`) once the horizon is reached. This is the feedback loop that turns
 * past scores into labeled ground truth for backtesting.
 */
export async function runOutcomes(
  sources: MaturationSources = defaultSources(),
): Promise<{ checked: number; matured: number }> {
  const sb = supabaseServer();
  const { data, error } = await sb.from("outcomes").select("*").eq("matured", false);
  if (error) throw new Error(`Failed to load outcomes: ${error.message}`);

  const rows = (data ?? []) as OutcomeRow[];
  if (rows.length === 0) return { checked: 0, matured: 0 };

  let maturedCount = 0;
  await mapLimit(rows, 4, async (row) => {
    if (!row.token_ref && !row.token_address) return;

    let latest: CurrentPrice;
    try {
      latest = await currentPriceForOutcome(row, sources);
    } catch (e) {
      logger.warn("outcome price lookup failed", { token: row.token_ref ?? row.token_address, error: String(e) });
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

    // Append to the price/volume time series (best-effort; only when we got a price).
    if (latest.priceUsd != null) {
      const { error: snapErr } = await sb.from("outcome_snapshots").insert({
        outcome_id: row.id,
        price_usd: latest.priceUsd,
        mcap_usd: latest.marketCapUsd,
        volume_usd: latest.volume24hUsd,
      });
      if (snapErr) logger.warn("snapshot insert failed", { id: row.id, error: snapErr.message });

      // Extend the canonical per-token series forward (current hour bucket).
      if (row.chain && row.token_address) {
        const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
        const { error: tphErr } = await sb.from("token_price_history").upsert(
          {
            chain: row.chain,
            token_address: row.token_address,
            observed_at: hour,
            price_usd: latest.priceUsd,
            volume_usd: latest.volume24hUsd,
            mcap_usd: latest.marketCapUsd,
            source: "gmgn",
          },
          { onConflict: "chain,token_address,observed_at", ignoreDuplicates: true },
        );
        if (tphErr) logger.warn("token_price_history upsert failed", { id: row.id, error: tphErr.message });
      }
    }
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
