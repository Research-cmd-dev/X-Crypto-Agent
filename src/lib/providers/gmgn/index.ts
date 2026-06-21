import type { GmgnProvider } from "@/lib/providers/gmgn/types";
import { GmgnApiProvider } from "@/lib/providers/gmgn/gmgn-api";
import { MockGmgnProvider } from "@/lib/providers/gmgn/mock";

export type {
  GmgnProvider,
  TokenSummary,
  TokenSecurity,
  TokenTrader,
  WalletTag,
  TrendingOptions,
} from "@/lib/providers/gmgn/types";
export { GmgnApiProvider } from "@/lib/providers/gmgn/gmgn-api";
export { MockGmgnProvider, MOCK_TOKENS } from "@/lib/providers/gmgn/mock";

/**
 * Default GMGN provider: the real API client when GMGN_API_KEY is configured,
 * otherwise the deterministic mock (so discovery/analysis run offline). Mirrors
 * `getXProvider()`.
 */
export function getGmgnProvider(): GmgnProvider {
  return process.env.GMGN_API_KEY ? new GmgnApiProvider() : new MockGmgnProvider();
}
