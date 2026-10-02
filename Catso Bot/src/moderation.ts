// =============================================================================
//  moderation.ts  -  Moderation commands for a Root Bot
//
//  Commands (prefix is configurable below):
//    !help
//    !kick   @user [reason]
//    !ban    @user [duration e.g. 30m / 12h / 7d / 2w] [reason]
//    !unban  @user | <userId>
//    !bans
//    !purge  <count> [@user]
//    !warn   @user <reason>
//    !warnings            (everyone with warnings)   |   !warnings @user (their warnings)
//    !warn remove <number>   |   !warn remove @user all      (warnings also expire on their own)
//    !role add    @user <@role | role name>
//    !role remove @user <@role | role name>
//    !roles
//
//  SECURITY: every command is locked to members who hold one of the staff roles
//  configured in CONFIG below. Everyone else is ignored (or told "no permission",
//  see CONFIG.replyWhenDenied). If no staff role can be found the bot FAILS
//  CLOSED: nobody can use any command.
// =============================================================================

import {
  rootServer,
  RootApiException,
  ErrorCodeType,
  ChannelMessageEvent,
  ChannelMessageCreatedEvent,
  ChannelMessage,
  CommunityRole,
  CommunityRoleGuid,
  MessageDirectionTake,
  MessageGuid,
  MessageType,
  RootGuidType,
  RootGuidUtils,
  UserGuid,
  WellKnownRootGuids,
} from "@rootsdk/server-bot";
import fs from "fs";
import path from "path";
import { normalizeId } from "./ids";

// -----------------------------------------------------------------------------
//  CONFIGURATION  -  edit this block
// -----------------------------------------------------------------------------
const CONFIG = {
  /** Every command must start with this. */
  prefix: "!",

  /**
   * Who may use the bot. A member needs AT LEAST ONE of these roles.
   *
   *  - staffRoleNames: easiest. Role names as they appear in Root (case-insensitive).
   *  - staffRoleIds:   most robust (survives renaming the role). Paste role GUIDs here.
   *                    Run `!roles` once to see the IDs, or check the bot's startup log.
   *
   * You can fill in either one or both.
   */
  staffRoleNames: ["Admins"] as string[],
  staffRoleIds: ["ADGY71GijwuK1K4Q3Q-GUg"] as string[],

  /** If a non-staff member types a real command, answer "no permission"? (false = ignore silently) */
  replyWhenDenied: true,

  /** Staff can't kick/ban other staff (or themselves). */
  protectStaff: true,

  /** Highest number of messages one !purge may delete. */
  maxPurge: 100,

  /** How many recent messages !purge @user looks through to find that user's messages. */
  purgeUserScanLimit: 100,

  /** Delete the bot's own confirmation messages (e.g. "Purged 20 messages") after this many ms. 0 = keep. */
  autoDeleteConfirmationsMs: 6000,

  /** Delete the staff member's command message after it runs (needs "delete other's messages" permission). */
  deleteCommandMessages: false,

  /** Time zone used when showing warning times, e.g. "UTC", "Africa/Cairo", "Asia/Baghdad". */
  timeZone: "Africa/Cairo",

  /** Warnings delete themselves after this many days. */
  warningExpiryDays: 7,

  /** Most warnings shown at once by !warnings @user (newest first). */
  maxWarningsShown: 15,

  /** Shown by !server */
  inviteLink: "https://rootapp.gg/ADGfG0M2ggqnu-LDlY3LOQ",

  /**
   * Root's bot API does not expose the community banner, so it can't be read automatically.
   * If you have a link to your banner image, paste it here and !server will show it. Leave "" to hide the line.
   */
  bannerUrl: "",

  /**
   * Commands (without the prefix) that EVERYONE may use, not just staff. Example: ["server"]
   * Leave empty to keep every command staff-only.
   */
  publicCommands: [] as string[],
};

// -----------------------------------------------------------------------------
//  Small utilities
// -----------------------------------------------------------------------------

/** An error whose message is safe/intended to show to the user in chat. */
class UserError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retry on rate-limit / transient errors (pattern from the Root docs). */
async function withRetry<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (err: unknown) {
      const retryable =
        err instanceof RootApiException
          ? err.errorCode === ErrorCodeType.TooManyRequests ||
            err.errorCode === ErrorCodeType.ServerError ||
            err.errorCode === ErrorCodeType.Timeout ||
            err.errorCode === ErrorCodeType.StillProcessing
          : false;
      if (attempt >= maxRetries || !retryable) throw err;
      const cap = Math.min(1000 * 2 ** attempt, 15000);
      await sleep(Math.random() * cap);
    }
  }
}

/** Turn any thrown error into a friendly one-line message. */
function describeError(err: unknown): string {
  if (err instanceof UserError) return err.message;
  if (err instanceof RootApiException) {
    switch (err.errorCode) {
      case ErrorCodeType.NoPermissionToKick:
        return "I don't have the Kick permission (or that member outranks me).";
      case ErrorCodeType.NoPermissionToBan:
        return "I don't have the Ban permission (or that member outranks me).";
      case ErrorCodeType.NoPermissionToDelete:
        return "I don't have permission to delete messages here.";
      case ErrorCodeType.NoPermissionToAdd:
      case ErrorCodeType.NoPermissionToEdit:
        return "I don't have permission to manage roles (or that role is above my own role).";
      case ErrorCodeType.NoPermissionToCreate:
      case ErrorCodeType.NoPermissionToRead:
        return "I'm missing a permission needed for that.";
      case ErrorCodeType.NotFound:
        return "I couldn't find that member, role or ban.";
      case ErrorCodeType.AlreadyExists:
        return "That already exists (e.g. the user is already banned).";
      case ErrorCodeType.RequestedSelf:
        return "I can't do that to myself.";
      case ErrorCodeType.TooManyRequests:
        return "I'm being rate limited. Try again in a moment.";
      default:
        return `Root API error: ${ErrorCodeType[err.errorCode] ?? err.errorCode}.`;
    }
  }
  return "Something went wrong.";
}

// -----------------------------------------------------------------------------
//  Tracking the bot's own messages (used by !clearbot)
//  leveling.ts calls trackMessage() for every message it sends.
// -----------------------------------------------------------------------------

const MAX_TRACKED_PER_CHANNEL = 200;
const trackedBotMessages = new Map<string, string[]>();

/** Remember a message the bot sent, so staff can wipe the bot's messages with !clearbot. */
export function trackMessage(channelId: string, messageId: string): void {
  const list = trackedBotMessages.get(channelId) ?? [];
  list.push(messageId);
  if (list.length > MAX_TRACKED_PER_CHANNEL) list.splice(0, list.length - MAX_TRACKED_PER_CHANNEL);
  trackedBotMessages.set(channelId, list);
}

// -----------------------------------------------------------------------------
//  Sending replies
// -----------------------------------------------------------------------------

/** Reply text must NEVER start with the prefix, or the bot could trigger itself. */
function safeText(text: string): string {
  return text.startsWith(CONFIG.prefix) ? "\u200B" + text : text;
}

async function reply(evt: ChannelMessageCreatedEvent, text: string, transient = false): Promise<void> {
  try {
    const sent = await withRetry(() =>
      rootServer.community.channelMessages.create({ channelId: evt.channelId, content: safeText(text) })
    );
    trackMessage(sent.channelId, sent.id);
    if (transient && CONFIG.autoDeleteConfirmationsMs > 0) {
      setTimeout(() => {
        rootServer.community.channelMessages
          .delete({ channelId: sent.channelId, id: sent.id })
          .catch(() => undefined);
      }, CONFIG.autoDeleteConfirmationsMs);
    }
  } catch (err) {
    console.error("[moderation] failed to send reply:", err);
  }
}

// -----------------------------------------------------------------------------
//  Staff / permission gate
// -----------------------------------------------------------------------------

/** Role IDs that count as "staff", resolved from CONFIG against the live role list. */
async function resolveStaffRoleIds(): Promise<Set<CommunityRoleGuid>> {
  const roles = await rootServer.community.communityRoles.list();
  const ids = new Set<string>(CONFIG.staffRoleIds);
  const names = CONFIG.staffRoleNames.map((n) => n.trim().toLowerCase()).filter(Boolean);
  const result = new Set<CommunityRoleGuid>();
  for (const role of roles) {
    if (ids.has(role.id) || names.includes(role.name.trim().toLowerCase())) result.add(role.id);
  }
  return result;
}

async function isStaff(userId: UserGuid, staffRoles?: Set<CommunityRoleGuid>): Promise<boolean> {
  const staff = staffRoles ?? (await resolveStaffRoleIds());
  if (staff.size === 0) return false; // fail closed
  try {
    const member = await rootServer.community.communityMembers.get({ userId });
    return member.communityRoleIds.some((id) => staff.has(id));
  } catch {
    return false; // can't verify => deny
  }
}

// -----------------------------------------------------------------------------
//  Command parsing
// -----------------------------------------------------------------------------

type Mention = { kind: "user" | "role" | "channel"; id: string; label: string };
type Arg = { type: "word"; text: string } | { type: "mention"; mention: Mention };

// Root encodes mentions in message text as:  [@Alice](root://user/<id>)
const MENTION_RE = /\[([^\]]*)\]\(root:\/\/(user|role|channel)\/([^)\s]+)\)/gi;
const MARK = "\u0001";

function parseArgs(content: string): Arg[] {
  const mentions: Mention[] = [];
  const replaced = content.replace(MENTION_RE, (_m, label: string, kind: string, id: string) => {
    mentions.push({ kind: kind.toLowerCase() as Mention["kind"], id: normalizeId(id), label });
    return ` ${MARK}${mentions.length - 1}${MARK} `;
  });
  return replaced
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok): Arg => {
      const m = /^\u0001(\d+)\u0001$/.exec(tok);
      return m ? { type: "mention", mention: mentions[Number(m[1])] } : { type: "word", text: tok };
    });
}

/** Text of the remaining args (mentions are shown by their label). */
function argsToText(args: Arg[]): string {
  return args.map((a) => (a.type === "word" ? a.text : a.mention.label)).join(" ").trim();
}

function looksLikeUserGuid(s: string): boolean {
  if (!/^[A-Za-z0-9_-]{22}$/.test(s)) return false;
  try {
    const t = RootGuidUtils.toRootGuidType(s);
    return t === RootGuidType.Person || t === RootGuidType.App;
  } catch {
    return false;
  }
}

/** Find (and remove) the first user in args: an @mention, or a raw user ID. */
function extractUser(args: Arg[]): { userId: UserGuid; label?: string } | undefined {
  const i = args.findIndex(
    (a) => (a.type === "mention" && a.mention.kind === "user") || (a.type === "word" && looksLikeUserGuid(a.text))
  );
  if (i < 0) return undefined;
  const [a] = args.splice(i, 1);
  return a.type === "mention"
    ? { userId: a.mention.id as UserGuid, label: a.mention.label.replace(/^@/, "") }
    : { userId: a.text as UserGuid };
}

/** Find (and remove) the first @role mention in args. */
function extractRoleMention(args: Arg[]): Mention | undefined {
  const i = args.findIndex((a) => a.type === "mention" && a.mention.kind === "role");
  if (i < 0) return undefined;
  const [a] = args.splice(i, 1);
  return a.type === "mention" ? a.mention : undefined;
}

/** "30m", "12h", "7d", "2w"  ->  milliseconds */
function parseDuration(token: string): number | undefined {
  const m = /^(\d+)([mhdw])$/i.exec(token);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2].toLowerCase() as "m" | "h" | "d" | "w"];
  return n > 0 ? n * unit : undefined;
}

// -----------------------------------------------------------------------------
//  Helpers that talk to Root
// -----------------------------------------------------------------------------

async function displayName(userId: UserGuid, hint?: string): Promise<string> {
  if (hint) return hint;
  try {
    const m = await rootServer.community.communityMembers.get({ userId });
    return m.nickname || "that user";
  } catch {
    return "that user";
  }
}

function requireUser(args: Arg[], usage: string): { userId: UserGuid; label?: string } {
  const u = extractUser(args);
  if (!u) throw new UserError(`Please mention a user. Usage: ${usage}`);
  return u;
}

async function guardTarget(executor: UserGuid, target: UserGuid): Promise<void> {
  if (target === executor) throw new UserError("You can't do that to yourself.");
  if (CONFIG.protectStaff && (await isStaff(target))) {
    throw new UserError("You can't do that to another staff member.");
  }
}

/** Find a role from an @role mention or a typed name (case-insensitive). */
async function resolveRole(args: Arg[], usage: string): Promise<CommunityRole> {
  const roles = await rootServer.community.communityRoles.list();
  const mention = extractRoleMention(args);
  let role: CommunityRole | undefined;

  if (mention) {
    role = roles.find((r) => r.id === mention.id);
    if (!role) role = roles.find((r) => r.name.toLowerCase() === mention.label.replace(/^@/, "").toLowerCase());
  } else {
    const typed = argsToText(args).replace(/^["'“”]+|["'“”]+$/g, "").replace(/^@/, "").trim().toLowerCase();
    if (!typed) throw new UserError(`Please give a role. Usage: ${usage}`);
    role = roles.find((r) => r.name.toLowerCase() === typed);
    if (!role) {
      const partial = roles.filter((r) => r.name.toLowerCase().startsWith(typed));
      if (partial.length === 1) role = partial[0];
      else if (partial.length > 1)
        throw new UserError(`Several roles match "${typed}": ${partial.map((r) => r.name).join(", ")}. Be more specific.`);
    }
  }
  if (!role) throw new UserError("I couldn't find that role. Use !roles to see the list.");
  if (role.id === WellKnownRootGuids.CommunityRoles.EveryoneRole)
    throw new UserError("The @everyone role can't be added or removed.");
  return role;
}

// -----------------------------------------------------------------------------
//  Warnings storage
//  - Every warning gets its own permanent number (#1, #2, #3 ...) that is never reused.
//  - Warnings expire automatically after CONFIG.warningExpiryDays.
//  - Saved in Root's key-value store (survives restarts). If that store isn't
//    available (e.g. some local setups) it falls back to a warnings.json file.
// -----------------------------------------------------------------------------

type Warning = { id: number; reason: string; at: number; byUserId: string; byName: string };
type WarningDb = { nextId: number; users: Record<string, Warning[]> }; // users: userId -> warnings, oldest first

const WARNINGS_KEY = "moderation:warnings:v2";
const OLD_WARNINGS_KEY = "moderation:warnings"; // first version (no warning numbers) - migrated automatically
const WARNINGS_FILE = path.join(process.cwd(), "warnings.json");
let warningsUseFile = false;

const DAY_MS = 86_400_000;
const expiryMs = (): number => CONFIG.warningExpiryDays * DAY_MS;

/** Drop warnings older than the expiry time (pure: returns a new object). */
function pruneExpired(db: WarningDb, now = Date.now()): WarningDb {
  const users: Record<string, Warning[]> = {};
  for (const [userId, list] of Object.entries(db.users)) {
    const keep = list.filter((w) => w.at + expiryMs() > now);
    if (keep.length > 0) users[userId] = keep;
  }
  return { nextId: db.nextId, users };
}

/** Convert the first-version data (userId -> warnings without numbers) into the numbered format. */
function migrateOld(old: Record<string, Omit<Warning, "id">[]>): WarningDb {
  const flat: { userId: string; w: Omit<Warning, "id"> }[] = [];
  for (const [userId, list] of Object.entries(old)) for (const w of list) flat.push({ userId, w });
  flat.sort((x, y) => x.w.at - y.w.at);
  const users: Record<string, Warning[]> = {};
  flat.forEach(({ userId, w }, i) => (users[userId] = [...(users[userId] ?? []), { ...w, id: i + 1 }]));
  return { nextId: flat.length + 1, users };
}

function isDb(x: unknown): x is WarningDb {
  return !!x && typeof x === "object" && "users" in (x as object) && "nextId" in (x as object);
}

function readWarningsFile(): WarningDb {
  try {
    if (!fs.existsSync(WARNINGS_FILE)) return { nextId: 1, users: {} };
    const raw = JSON.parse(fs.readFileSync(WARNINGS_FILE, "utf-8"));
    return isDb(raw) ? raw : migrateOld(raw);
  } catch (err) {
    console.error("[moderation] could not read warnings.json:", err);
    return { nextId: 1, users: {} };
  }
}

/** Reads the stored data as-is (no expiry applied). */
async function readRawWarnings(): Promise<WarningDb> {
  if (!warningsUseFile) {
    try {
      const kv = rootServer.dataStore.appData;
      const current = await kv.get<WarningDb>(WARNINGS_KEY);
      if (current) return current;
      const old = await kv.get<Record<string, Omit<Warning, "id">[]>>(OLD_WARNINGS_KEY);
      return old ? migrateOld(old) : { nextId: 1, users: {} };
    } catch (err) {
      console.warn("[moderation] key-value store unavailable, using warnings.json instead:", err);
      warningsUseFile = true;
    }
  }
  return readWarningsFile();
}

/** Current warnings, with expired ones already removed. */
async function loadWarnings(): Promise<WarningDb> {
  return pruneExpired(await readRawWarnings());
}

/**
 * Safely change the warnings: expired ones are dropped, `change` edits the data and
 * returns a result, and the new data is saved.
 */
async function changeWarnings<T>(change: (db: WarningDb) => { db: WarningDb; result: T }): Promise<T> {
  let result!: T;
  const apply = (stored: WarningDb): WarningDb => {
    const out = change(pruneExpired(stored));
    result = out.result;
    return out.db;
  };

  if (!warningsUseFile) {
    try {
      const base = await readRawWarnings();
      if (!warningsUseFile) {
        await rootServer.dataStore.appData.update<WarningDb>(WARNINGS_KEY, apply, base);
        return result;
      }
    } catch (err) {
      console.warn("[moderation] key-value store unavailable, using warnings.json instead:", err);
      warningsUseFile = true;
    }
  }
  const saved = apply(readWarningsFile());
  fs.writeFileSync(WARNINGS_FILE, JSON.stringify(saved, null, 2), "utf-8");
  return result;
}

/** Adds a warning. Returns its number and how many active warnings the user now has. */
async function addWarning(userId: string, w: Omit<Warning, "id">): Promise<{ id: number; total: number }> {
  return changeWarnings((db) => {
    const id = db.nextId;
    const list = [...(db.users[userId] ?? []), { ...w, id }];
    return { db: { nextId: id + 1, users: { ...db.users, [userId]: list } }, result: { id, total: list.length } };
  });
}

/** Removes one warning by its number. Returns what was removed (or undefined if not found). */
async function removeWarningById(id: number): Promise<{ userId: string; warning: Warning; left: number } | undefined> {
  return changeWarnings((db) => {
    for (const [userId, list] of Object.entries(db.users)) {
      const found = list.find((w) => w.id === id);
      if (!found) continue;
      const rest = list.filter((w) => w.id !== id);
      const users = { ...db.users };
      if (rest.length > 0) users[userId] = rest;
      else delete users[userId];
      return { db: { nextId: db.nextId, users }, result: { userId, warning: found, left: rest.length } };
    }
    return { db, result: undefined };
  });
}

/** Removes every warning a user has. Returns how many were removed. */
async function clearWarningsFor(userId: string): Promise<number> {
  return changeWarnings((db) => {
    const count = db.users[userId]?.length ?? 0;
    const users = { ...db.users };
    delete users[userId];
    return { db: { nextId: db.nextId, users }, result: count };
  });
}

/** Starts the background clean-up that permanently deletes expired warnings (hourly + once now). */
function startWarningCleanup(): void {
  const run = (): void => {
    changeWarnings((db) => ({ db, result: 0 })).catch((err) =>
      console.warn("[moderation] warning clean-up failed:", err)
    );
  };
  run();
  setInterval(run, 60 * 60 * 1000);
}

function formatTime(ms: number): string {
  const when = new Intl.DateTimeFormat("en-GB", {
    timeZone: CONFIG.timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(new Date(ms));

  const mins = Math.floor((Date.now() - ms) / 60_000);
  let ago: string;
  if (mins < 1) ago = "just now";
  else if (mins < 60) ago = `${mins}m ago`;
  else if (mins < 60 * 24) ago = `${Math.floor(mins / 60)}h ago`;
  else ago = `${Math.floor(mins / (60 * 24))}d ago`;
  return `${when} (${ago})`;
}

/** "6d left", "5h left" ... */
function expiresIn(at: number): string {
  const msLeft = at + expiryMs() - Date.now();
  if (msLeft <= 0) return "expiring";
  const mins = Math.ceil(msLeft / 60_000);
  if (mins < 60) return `${mins}m left`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h left`;
  return `${Math.floor(mins / (60 * 24))}d left`;
}

/** Look up many members' names at once. Users who left the server are missing from the result. */
async function nicknames(userIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let i = 0; i < userIds.length; i += 50) {
    try {
      const batch = await rootServer.community.communityMembers.list({ userIds: userIds.slice(i, i + 50) as UserGuid[] });
      for (const m of batch) names.set(m.userId, m.nickname);
    } catch {
      /* ignore - we'll fall back to showing the ID */
    }
  }
  return names;
}

// -----------------------------------------------------------------------------
//  Commands
// -----------------------------------------------------------------------------

type Ctx = { evt: ChannelMessageCreatedEvent; args: Arg[] };
type Command = { description: string; run: (ctx: Ctx) => Promise<void> };

const P = CONFIG.prefix;

const COMMANDS: Record<string, Command> = {
  // ---------------------------------------------------------------- help
  help: {
    description: "Show this list",
    run: async ({ evt }) => {
      const lines = [
        "**Moderation commands (staff only)**",
        `${P}kick @user [reason]`,
        `${P}ban @user [30m|12h|7d|2w] [reason]`,
        `${P}unban @user | <userId>`,
        `${P}bans`,
        `${P}purge <count> [@user]`,
        `${P}warn @user <reason>`,
        `${P}warnings`,
        `${P}warnings @user`,
        `${P}warn remove <number>`,
        `${P}warn remove @user all`,
        `${P}clearbot [count]`,
        `${P}server`,
        `${P}role add @user <@role | role name>`,
        `${P}role remove @user <@role | role name>`,
        `${P}roles`,
      ];
      await reply(evt, lines.join("\n"));
    },
  },

  // ---------------------------------------------------------------- kick
  kick: {
    description: "Kick a member",
    run: async ({ evt, args }) => {
      const target = requireUser(args, `${P}kick @user [reason]`);
      await guardTarget(evt.userId, target.userId);
      const name = await displayName(target.userId, target.label); // look up BEFORE kicking
      const reason = argsToText(args);
      await withRetry(() => rootServer.community.communityMemberBans.kick({ userId: target.userId }));
      await reply(evt, `Kicked ${name}${reason ? ` - ${reason}` : ""}.`);
    },
  },

  // ---------------------------------------------------------------- ban
  ban: {
    description: "Ban a member (optionally temporary)",
    run: async ({ evt, args }) => {
      const target = requireUser(args, `${P}ban @user [duration] [reason]`);
      await guardTarget(evt.userId, target.userId);
      const name = await displayName(target.userId, target.label);

      // Optional duration as the first remaining word: 30m, 12h, 7d, 2w
      let expiresAt: Date | undefined;
      let durationText = "permanently";
      const first = args[0];
      if (first && first.type === "word") {
        const ms = parseDuration(first.text);
        if (ms) {
          expiresAt = new Date(Date.now() + ms);
          durationText = `for ${first.text.toLowerCase()}`;
          args.shift();
        }
      }
      const reason = argsToText(args);

      await withRetry(() =>
        rootServer.community.communityMemberBans.create({
          userId: target.userId,
          ...(reason ? { reason } : {}),
          ...(expiresAt ? { expiresAt } : {}),
        })
      );
      await reply(evt, `Banned ${name} ${durationText}${reason ? ` - ${reason}` : ""}.`);
    },
  },

  // ---------------------------------------------------------------- unban
  unban: {
    description: "Unban a member",
    run: async ({ evt, args }) => {
      const target = requireUser(args, `${P}unban @user  (or ${P}unban <userId> - see ${P}bans)`);
      await withRetry(() => rootServer.community.communityMemberBans.delete({ userId: target.userId }));
      await reply(evt, `Unbanned ${target.label ?? target.userId}.`);
    },
  },

  // ---------------------------------------------------------------- bans
  bans: {
    description: "List banned users",
    run: async ({ evt }) => {
      const bans = await rootServer.community.communityMemberBans.list();
      if (bans.length === 0) return reply(evt, "No one is banned.");
      const lines = bans.slice(0, 25).map((b) => {
        const until = b.expiresAt ? ` (until ${b.expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC)` : "";
        return `- ${b.userId}${until}${b.reason ? ` - ${b.reason}` : ""}`;
      });
      const more = bans.length > 25 ? `\n...and ${bans.length - 25} more` : "";
      await reply(evt, `**Bans (${bans.length})** - use ${P}unban <userId>\n${lines.join("\n")}${more}`);
    },
  },

  // ---------------------------------------------------------------- purge
  purge: {
    description: "Bulk-delete recent messages",
    run: async ({ evt, args }) => {
      const usage = `${P}purge <count> [@user]`;
      const onlyUser = extractUser(args);
      const countArg = args.find((a) => a.type === "word" && /^\d+$/.test(a.text));
      const count = countArg && countArg.type === "word" ? Number(countArg.text) : NaN;
      if (!Number.isInteger(count) || count < 1) throw new UserError(`Please give a number. Usage: ${usage}`);
      if (count > CONFIG.maxPurge) throw new UserError(`The maximum per purge is ${CONFIG.maxPurge}.`);

      // Remove the staff member's command message first so it isn't in the way.
      await rootServer.community.channelMessages.delete({ channelId: evt.channelId, id: evt.id }).catch(() => undefined);

      const deleted = await purgeMessages(evt, count, onlyUser?.userId);
      const who = onlyUser ? ` from ${onlyUser.label ?? "that user"}` : "";
      await reply(evt, `Purged ${deleted} message${deleted === 1 ? "" : "s"}${who}.`, true);
    },
  },

  // ---------------------------------------------------------------- warn
  warn: {
    description: "Give a member a warning, or remove one",
    run: async ({ evt, args }) => {
      // ---- !warn remove <number>   |   !warn remove @user all
      const first = args[0];
      if (first && first.type === "word" && first.text.toLowerCase() === "remove") {
        args.shift();
        const usage = `${P}warn remove <warning number>   or   ${P}warn remove @user all`;
        const user = extractUser(args);

        if (user) {
          const wantsAll = args.some((a) => a.type === "word" && a.text.toLowerCase() === "all");
          if (!wantsAll) throw new UserError(`To clear all of someone's warnings use: ${P}warn remove @user all`);
          const name = await displayName(user.userId, user.label);
          const n = await clearWarningsFor(user.userId);
          if (n === 0) throw new UserError(`${name} has no warnings.`);
          return reply(evt, `Removed all ${n} warning${n === 1 ? "" : "s"} from ${name}.`);
        }

        const numArg = args.find((a) => a.type === "word" && /^#?\d+$/.test(a.text));
        if (!numArg || numArg.type !== "word") throw new UserError(`Please give the warning number. Usage: ${usage}`);
        const id = Number(numArg.text.replace("#", ""));
        const removed = await removeWarningById(id);
        if (!removed) throw new UserError(`I couldn't find warning #${id} (it may have expired or been removed).`);
        const name = await displayName(removed.userId as UserGuid);
        return reply(
          evt,
          `Removed warning #${id} from ${name} (${removed.warning.reason}). They now have ${removed.left} warning${removed.left === 1 ? "" : "s"}.`
        );
      }

      // ---- !warn @user <reason>
      const target = requireUser(args, `${P}warn @user <reason>`);
      await guardTarget(evt.userId, target.userId);
      const name = await displayName(target.userId, target.label);
      const reason = argsToText(args) || "No reason given";
      const byName = await displayName(evt.userId);

      const { id, total } = await addWarning(target.userId, { reason, at: Date.now(), byUserId: evt.userId, byName });
      await reply(
        evt,
        `Warning #${id} given to ${name} - ${reason}\n${name} now has ${total} active warning${total === 1 ? "" : "s"} (each expires after ${CONFIG.warningExpiryDays} days).`
      );
    },
  },

  // ---------------------------------------------------------------- warnings
  warnings: {
    description: "List warnings (all members, or one member)",
    run: async ({ evt, args }) => {
      const db = await loadWarnings();
      const target = extractUser(args);

      // !warnings @user  ->  that member's warnings with number, reason, time
      if (target) {
        const list = db.users[target.userId] ?? [];
        const name = await displayName(target.userId, target.label);
        if (list.length === 0) return reply(evt, `${name} has no warnings.`);

        const shown = list.slice(-CONFIG.maxWarningsShown);
        const lines = shown.map(
          (w) => `#${w.id} ${w.reason} - ${formatTime(w.at)} - by ${w.byName} - ${expiresIn(w.at)}`
        );
        const more = shown.length < list.length ? `\n(showing the latest ${shown.length} of ${list.length})` : "";
        return reply(
          evt,
          `**Warnings for ${name} (${list.length})**\n${lines.join("\n")}${more}\nRemove one with ${P}warn remove <number>`
        );
      }

      // !warnings  ->  everyone who has warnings, with counts
      const entries = Object.entries(db.users).filter(([, list]) => list.length > 0);
      if (entries.length === 0) return reply(evt, "No one has any active warnings.");
      entries.sort((a, b) => b[1].length - a[1].length);

      const top = entries.slice(0, 25);
      const names = await nicknames(top.map(([id]) => id));
      const lines = top.map(([id, list], i) => {
        const who = names.get(id) ?? `(left the server) ${id}`;
        return `${i + 1}. ${who} - ${list.length} warning${list.length === 1 ? "" : "s"}`;
      });
      const more = entries.length > 25 ? `\n...and ${entries.length - 25} more members` : "";
      await reply(
        evt,
        `**Members with warnings (${entries.length})**\n${lines.join("\n")}${more}\nUse ${P}warnings @user for details.`
      );
    },
  },

  // ---------------------------------------------------------------- server
  server: {
    description: "Show server stats, picture and invite link",
    run: async ({ evt }) => {
      const community = await rootServer.community.communities.get();

      // Members (the API has no ready-made count, so we count the member list)
      const members = await rootServer.community.communityMembers.listAll();
      const bots = members.filter((m) => {
        try {
          return RootGuidUtils.toRootGuidType(m.userId) === RootGuidType.App;
        } catch {
          return false;
        }
      }).length;
      const humans = members.length - bots;

      const roles = (await rootServer.community.communityRoles.list()).filter(
        (r) => r.id !== WellKnownRootGuids.CommunityRoles.EveryoneRole
      );

      const lines: string[] = [`**${community.name}**`];
      if (community.description) lines.push(community.description);
      lines.push("");
      lines.push(`Members: **${members.length}** (${humans} people, ${bots} bots)`);
      lines.push(`Roles: **${roles.length}**`);
      lines.push(`Invite: ${CONFIG.inviteLink}`);
      if (CONFIG.bannerUrl) lines.push(`Banner: ${CONFIG.bannerUrl}`);
      const content = safeText(lines.join("\n"));

      // Try to attach the server picture. If Root refuses, send the text without it.
      if (community.pictureAssetUri) {
        try {
          const sent = await withRetry(() =>
            rootServer.community.channelMessages.create({
              channelId: evt.channelId,
              content,
              attachmentTokenUris: [community.pictureAssetUri as string],
            })
          );
          trackMessage(sent.channelId, sent.id);
          return;
        } catch (err) {
          console.warn("[moderation] !server: could not attach the server picture, sending text only:", err);
        }
      }
      await reply(evt, content);
    },
  },

  // ---------------------------------------------------------------- clearbot
  clearbot: {
    description: "Delete the bot's own recent messages in this channel",
    run: async ({ evt, args }) => {
      const countArg = args.find((a) => a.type === "word" && /^\d+$/.test(a.text));
      const limit = countArg && countArg.type === "word" ? Number(countArg.text) : CONFIG.maxPurge;
      const tracked = trackedBotMessages.get(evt.channelId) ?? [];
      const ids = tracked.slice(-Math.min(limit, CONFIG.maxPurge)).reverse(); // newest first
      if (ids.length === 0) throw new UserError("I have no recent messages of mine to clear in this channel.");

      let deleted = 0;
      for (const id of ids) {
        try {
          await withRetry(() =>
            rootServer.community.channelMessages.delete({ channelId: evt.channelId, id: id as MessageGuid })
          );
          deleted++;
        } catch {
          // already deleted / not deletable - skip it
        }
        trackedBotMessages.set(evt.channelId, (trackedBotMessages.get(evt.channelId) ?? []).filter((x) => x !== id));
        await sleep(250);
      }
      await reply(evt, `Cleared ${deleted} of my message${deleted === 1 ? "" : "s"}.`, true);
    },
  },

  // ---------------------------------------------------------------- role add / remove
  role: {
    description: "Add or remove a role from a member",
    run: async ({ evt, args }) => {
      const usage = `${P}role add @user <@role | role name>   or   ${P}role remove @user <@role | role name>`;
      const sub = args[0] && args[0].type === "word" ? args[0].text.toLowerCase() : "";
      if (sub !== "add" && sub !== "remove") throw new UserError(`Usage: ${usage}`);
      args.shift();

      const target = requireUser(args, usage);
      const role = await resolveRole(args, usage);
      const name = await displayName(target.userId, target.label);

      let current: readonly CommunityRoleGuid[];
      try {
        current = (await rootServer.community.communityMembers.get({ userId: target.userId })).communityRoleIds;
      } catch {
        throw new UserError("I couldn't find that member in this community.");
      }
      const has = current.includes(role.id);

      if (sub === "add") {
        if (has) throw new UserError(`${name} already has the ${role.name} role.`);
        await withRetry(() =>
          rootServer.community.communityMemberRoles.add({ communityRoleId: role.id, userIds: [target.userId] })
        );
        await reply(evt, `Added the ${role.name} role to ${name}.`);
      } else {
        if (!has) throw new UserError(`${name} doesn't have the ${role.name} role.`);
        await withRetry(() =>
          rootServer.community.communityMemberRoles.remove({ communityRoleId: role.id, userIds: [target.userId] })
        );
        await reply(evt, `Removed the ${role.name} role from ${name}.`);
      }
    },
  },

  // ---------------------------------------------------------------- roles
  roles: {
    description: "List roles and their IDs",
    run: async ({ evt }) => {
      const roles = await rootServer.community.communityRoles.list();
      const lines = roles
        .filter((r) => r.id !== WellKnownRootGuids.CommunityRoles.EveryoneRole)
        .map((r) => `- ${r.name}  (id: ${r.id})`);
      await reply(evt, lines.length ? `**Roles**\n${lines.join("\n")}` : "There are no roles yet.");
    },
  },
};

// -----------------------------------------------------------------------------
//  Purge implementation
// -----------------------------------------------------------------------------

const PAGE = 50;

async function listRecent(channelId: ChannelMessage["channelId"], limit: number): Promise<ChannelMessage[]> {
  const res = await withRetry(() =>
    rootServer.community.channelMessages.list({
      channelId,
      messageDirectionTake: MessageDirectionTake.Older,
      dateAt: new Date(Date.now() + 60_000), // "now" (slightly ahead to include the newest message)
      limit,
    })
  );
  // newest first
  return res.messages
    .filter((m) => !m.deletedAt)
    .sort((a, b) => RootGuidUtils.toMilliseconds(b.id) - RootGuidUtils.toMilliseconds(a.id));
}

async function purgeMessages(evt: ChannelMessageCreatedEvent, count: number, onlyUser?: UserGuid): Promise<number> {
  let deleted = 0;

  const deleteOne = async (m: ChannelMessage): Promise<boolean> => {
    try {
      await withRetry(() => rootServer.community.channelMessages.delete({ channelId: m.channelId, id: m.id }));
      deleted++;
      return true;
    } catch (err) {
      // Permission problems will fail every delete - surface that instead of silently stopping.
      if (err instanceof RootApiException && err.errorCode === ErrorCodeType.NoPermissionToDelete) throw err;
      console.warn("[moderation] could not delete a message:", err);
      return false;
    } finally {
      await sleep(250); // pace to ~4 deletes/sec (limit is ~5/sec)
    }
  };

  if (onlyUser) {
    // One scan of the most recent messages, delete the first `count` that belong to that user.
    const recent = await listRecent(evt.channelId, CONFIG.purgeUserScanLimit);
    for (const m of recent.filter((x) => x.userId === onlyUser).slice(0, count)) await deleteOne(m);
    return deleted;
  }

  // No user filter: repeatedly fetch the newest messages and delete them.
  while (deleted < count) {
    const batch = (await listRecent(evt.channelId, Math.min(PAGE, count - deleted))).slice(0, count - deleted);
    if (batch.length === 0) break;
    const before = deleted;
    for (const m of batch) await deleteOne(m);
    if (deleted === before) break; // nothing could be deleted - avoid looping forever
  }
  return deleted;
}

// -----------------------------------------------------------------------------
//  Message handler (the gate lives here)
// -----------------------------------------------------------------------------

async function onMessage(evt: ChannelMessageCreatedEvent): Promise<void> {
  try {
    // Only real user/bot messages - never system messages.
    if (evt.messageType !== MessageType.UserMessage) return;

    const content = (evt.messageContent ?? "").trim();
    if (!content.startsWith(CONFIG.prefix)) return;

    const args = parseArgs(content.slice(CONFIG.prefix.length));
    const first = args.shift();
    if (!first || first.type !== "word") return;

    const command = COMMANDS[first.text.toLowerCase()];
    if (!command) return; // not one of ours - ignore silently

    // ---- THE GATE: only staff may use any command -------------------------
    const isPublic = CONFIG.publicCommands.map((c) => c.toLowerCase()).includes(first.text.toLowerCase());
    const staffRoles = await resolveStaffRoleIds();
    if (!isPublic && !(await isStaff(evt.userId, staffRoles))) {
      if (CONFIG.replyWhenDenied) {
        await reply(evt, "You don't have permission to use moderation commands.", true);
      }
      return;
    }
    // ------------------------------------------------------------------------

    try {
      await command.run({ evt, args });
    } catch (err) {
      if (!(err instanceof UserError)) console.error(`[moderation] ${first.text} failed:`, err);
      await reply(evt, describeError(err), true);
    }

    if (CONFIG.deleteCommandMessages && first.text.toLowerCase() !== "purge") {
      rootServer.community.channelMessages.delete({ channelId: evt.channelId, id: evt.id }).catch(() => undefined);
    }
  } catch (err) {
    // Never let an exception escape an event handler - Root restarts the bot if it does.
    console.error("[moderation] unhandled error:", err);
  }
}

// -----------------------------------------------------------------------------
//  Public entry point
// -----------------------------------------------------------------------------

/** Call once from main.ts, before/at startup. */
export function initializeModeration(): void {
  rootServer.community.channelMessages.on(ChannelMessageEvent.ChannelMessageCreated, onMessage);
  startWarningCleanup();
}

/** Call from your starting callback: logs which roles are staff, and warns if none match. */
export async function logModerationStatus(): Promise<void> {
  try {
    const roles: CommunityRole[] = await rootServer.community.communityRoles.list();
    const staff = await resolveStaffRoleIds();
    if (staff.size === 0) {
      console.warn(
        "[moderation] WARNING: no staff role matched CONFIG.staffRoleNames / staffRoleIds. " +
          "NOBODY can use moderation commands until you fix this."
      );
    } else {
      const names = roles.filter((r) => staff.has(r.id)).map((r) => `${r.name} (${r.id})`);
      console.log(`[moderation] ready. Staff roles: ${names.join(", ")}`);
    }
    console.log("[moderation] roles in this community:");
    for (const r of roles) console.log(`   ${r.name}  ->  ${r.id}`);
  } catch (err) {
    console.error("[moderation] could not read roles at startup:", err);
  }
}
