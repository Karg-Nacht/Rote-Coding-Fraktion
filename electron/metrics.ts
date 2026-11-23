import type { SessionInfo, SessionMessageInfo } from "@opencode/client";
import type { SessionMetrics } from "../shared/rcf";
import { interrupted } from './timeline';
export function sessionMetrics(
  info: SessionInfo,
  messages: SessionMessageInfo[],
  partial: boolean,
): SessionMetrics {
  const assistants = messages.filter((m) => m.type === "assistant");
  const last = [...assistants].reverse().find((m) => m.tokens);
  return {
    input: info.tokens.input,
    output: info.tokens.output,
    reasoning: info.tokens.reasoning,
    cacheRead: info.tokens.cache.read,
    cacheWrite: info.tokens.cache.write,
    cost: info.cost,
    contextInput: last?.tokens
      ? last.tokens.input + last.tokens.cache.read
      : undefined,
    compactions: messages.filter((m) => m.type === "compaction").length,
    retries: assistants.filter((m) => m.retry).length,
    errors: assistants.flatMap((m) => (m.error && !interrupted(m.error) ? [m.error.message] : [])),
    partial,
  };
}
