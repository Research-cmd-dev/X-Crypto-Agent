import { cn } from "@/lib/utils";

function colorFor(score: number): string {
  if (score >= 70) return "bg-emerald-600";
  if (score >= 40) return "bg-amber-500";
  return "bg-red-500";
}

export function ScoreBar({
  score,
  label,
  showValue = true,
}: {
  score: number;
  label?: string;
  showValue?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="flex items-center gap-2">
      {label ? <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span> : null}
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", colorFor(pct))} style={{ width: `${pct}%` }} />
      </div>
      {showValue ? <span className="w-8 shrink-0 text-right text-xs tabular-nums">{pct}</span> : null}
    </div>
  );
}
