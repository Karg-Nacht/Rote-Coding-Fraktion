// Tool envelopes often contain JSON-encoded text. Unwrap known envelopes only;
// retain unfamiliar structured results in readable, indented form.
export function safeToolData(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[Вложенные данные]";
  if (Array.isArray(value))
    return value.slice(0, 1000).map((v) => safeToolData(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/^(reasoning|reasoning_content|chain_of_thought|thinking|signature)$/i.test(
              key,
            ),
        )
        .map(([key, v]) => [key, safeToolData(v, depth + 1)]),
    );
  return value;
}
export function formatToolOutput(value: unknown, depth = 0): string {
  if (depth > 3)
    return typeof value === "string"
      ? value
      : JSON.stringify(safeToolData(value), null, 2);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length < 2_000_000 && /^[\[{"]/.test(trimmed)) {
      try {
        return formatToolOutput(JSON.parse(trimmed), depth + 1);
      } catch {
        /* Ordinary output remains literal. */
      }
    }
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (
      Array.isArray(obj.content) &&
      obj.content.some((v) => v?.type === "text")
    )
      return obj.content
        .filter((v) => v?.type === "text")
        .map((v) => formatToolOutput(v.text, depth + 1))
        .join("\n\n");
    if (typeof obj.output === "string")
      return formatToolOutput(obj.output, depth + 1);
    if (typeof obj.result === "string")
      return formatToolOutput(obj.result, depth + 1);
  }
  return JSON.stringify(safeToolData(value), null, 2) ?? "";
}
