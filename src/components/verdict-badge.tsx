import { Badge } from "@/components/ui/badge";
import type { Verdict } from "@/lib/supabase/types";

const VARIANT: Record<Verdict, "success" | "warning" | "destructive"> = {
  High: "success",
  Monitor: "warning",
  Avoid: "destructive",
};

export function VerdictBadge({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return <Badge variant="outline">Pending</Badge>;
  return <Badge variant={VARIANT[verdict]}>{verdict}</Badge>;
}
