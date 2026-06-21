import type { XProvider } from "@/lib/providers/x/types";
import { XApiProvider } from "@/lib/providers/x/x-api";

export type { XProvider, XUser, XTweet } from "@/lib/providers/x/types";
export { XApiProvider } from "@/lib/providers/x/x-api";
export { MockXProvider } from "@/lib/providers/x/mock";

/** Default provider for production code (real X API v2). */
export function getXProvider(): XProvider {
  return new XApiProvider();
}
