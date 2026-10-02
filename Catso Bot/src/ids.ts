// =============================================================================
//  ids.ts - small helpers shared by leveling.ts and moderation.ts
// =============================================================================

const LONG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32 = /^[0-9a-f]{32}$/i;

/**
 * Root's SDK uses the 22-character "short" base64url form for every ID.
 * Mention links in message text can contain either form, so this converts a
 * long UUID (550e8400-e29b-41d4-a716-446655440000) to the short form and
 * leaves an ID that is already short untouched.
 */
export function normalizeId(id: string): string {
  const raw = id.trim();
  if (!LONG_UUID.test(raw) && !HEX32.test(raw)) return raw;
  const hex = raw.replace(/-/g, "");
  return Buffer.from(hex, "hex")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Matches [@Name](root://user/<id>) anywhere in a message. Works for short and long IDs. */
const USER_MENTION_RE = /\[@?([^\]]*)\]\(root:\/\/user\/([^)\s]+)\)/i;

/** First user mention in `text`, with its (normalized) ID and display name. */
export function findUserMention(text: string): { userId: string; name: string } | undefined {
  const m = USER_MENTION_RE.exec(text);
  if (!m) return undefined;
  return { userId: normalizeId(m[2]), name: m[1] || "User" };
}
