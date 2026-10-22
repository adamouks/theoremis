const CODE_SPANS = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;

/**
 * Rewrites the math delimiters models commonly emit into forms remark-math understands:
 * `\[…\]` and a line holding only `$$…$$` become display blocks (remark-math treats a
 * one-line `$$…$$` as inline), and `\(…\)` becomes `$…$`. Code spans and fences are left
 * alone, including a fence that is still open mid-stream.
 */
export function normalizeMath(markdown: string): string {
  return markdown
    .split(CODE_SPANS)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment
        .replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
        .replace(/^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm, (_, body: string) => `$$\n${body.trim()}\n$$`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${body.trim()}$`);
    })
    .join("");
}

/** A short sidebar title from the first message of a conversation. */
export function deriveTitle(text: string, max = 60): string {
  const firstLine =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const plain = firstLine
    .replace(/[#>*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "New chat";
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

export type DateGroup = "Today" | "Yesterday" | "Previous 7 days" | "Previous 30 days" | "Older";

/** Buckets a timestamp relative to `now` by calendar day, for grouping the sidebar. */
export function dateGroup(timestamp: number, now = Date.now()): DateGroup {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const day = 24 * 60 * 60 * 1000;
  const today = startOfToday.getTime();
  if (timestamp >= today) return "Today";
  if (timestamp >= today - day) return "Yesterday";
  if (timestamp >= today - 7 * day) return "Previous 7 days";
  if (timestamp >= today - 30 * day) return "Previous 30 days";
  return "Older";
}

export function newId(): string {
  return crypto.randomUUID();
}
