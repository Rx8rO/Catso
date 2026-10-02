import {
  rootServer,
  RootApiException,
  ErrorCodeType,
  RootBotStartState,
  MessageType,
  ChannelMessageEvent,
  ChannelMessageCreatedEvent,
  ChannelMessageEditedEvent,
  ChannelGuid,
  CommunityMemberRoleAddRequest,
  CommunityRoleGuid,
  RootGuidType,
  RootGuidUtils,
  UserGuid,
} from "@rootsdk/server-bot";

let memberRoleId: CommunityRoleGuid | undefined;

export function initializeBotFeatures(state: RootBotStartState): void {
  const roleName = "Member"; 
  
  console.log("--- Scanning Community Roles at Startup ---");
  for (const [roleId, role] of state.communityRoles) {
    console.log(`Found Role: "${role.name}" (ID: ${roleId})`);
    if (role.name.trim().toLowerCase() === roleName.toLowerCase()) {
      memberRoleId = roleId;
      console.log(`-> Successfully matched auto-role to ID: ${roleId}`);
      break;
    }
  }

  if (!memberRoleId) {
    console.error(`❌ Role "${roleName}" not found in community roles snapshot! Auto-role will be disabled.`);
  }

  // Listen for all messages (including system messages for joins)
  rootServer.community.channelMessages.on(ChannelMessageEvent.ChannelMessageCreated, onMessage);

  // Bad-word filter (see the WORD FILTER section at the bottom of this file)
  initializeWordFilter();
}

async function onMessage(evt: ChannelMessageCreatedEvent): Promise<void> {
  try {
    // If it's a system message, log the whole object to see how joins are represented
    if (evt.messageType === MessageType.System) {
      console.log("Full system message event object:", JSON.stringify(evt, null, 2));
      
      // Attempt to extract user ID from standard system payload fields
      const targetUserId = (evt as any).userId || (evt as any).targetUserId || (evt as any).authorId;
      const systemText = (evt as any).messageContent || "";

      if (targetUserId) {
        console.log(`-> Detected system event target user ID: ${targetUserId}`);
        await assignMemberRole(targetUserId);
      }
      return;
    }

    // Normal chat messages ("meow")
    const messageText = (evt as any).messageContent || (evt as any).content || (evt as any).text || "";
    console.log(`[Message Received]: "${messageText}"`);

    if (messageText.trim().toLowerCase() === "meow") {
      console.log("-> Matched 'meow'! Replying...");
      await rootServer.community.channelMessages.create({
        channelId: evt.channelId,
        content: "stfu gang",
      } as any);
    }
  } catch (xcpt: unknown) {
    handleError(xcpt);
  }
}

async function assignMemberRole(userId: string): Promise<void> {
  if (!memberRoleId) {
    console.warn("⚠️ Cannot assign role, memberRoleId is undefined!");
    return;
  }

  const request: CommunityMemberRoleAddRequest = {
    communityRoleId: memberRoleId,
    userIds: [userId as UserGuid],
  };

  await rootServer.community.communityMemberRoles.add(request);
  console.log(`Successfully assigned Member role to user ${userId}`);
}

function handleError(xcpt: unknown): void {
  if (xcpt instanceof RootApiException) {
    switch (xcpt.errorCode) {
      case ErrorCodeType.TooManyRequests:
        console.error("Rate limited — commands max ~5 req/s");
        break;
      default:
        console.error("RootApiException:", xcpt.errorCode);
    }
  } else if (xcpt instanceof Error) {
    console.error("Unexpected error:", xcpt.message);
  }
}


// =============================================================================
//  WORD FILTER
//  Deletes messages that contain a blocked word and writes a log entry (with the
//  full original message) to your log channel.
// =============================================================================

// -----------------------------------------------------------------------------
//  CONFIGURATION  -  edit this block
// -----------------------------------------------------------------------------
const WORD_FILTER = {
  enabled: true,

  /**
   * Words / phrases to block (case-insensitive). Add as many as you like, in any language.
   * This is only a STARTER list - please edit it for your community.
   * Matching is by whole word, so blocking "dick" will NOT delete "Dickens" or "predict".
   * Also caught automatically: repeated letters (fuuuck), look-alike symbols/numbers (sh1t, @sshole),
   * spaced-out letters (f u c k, f.u.c.k), accents, and Arabic diacritics.
   * NOT caught: a letter replaced by a symbol that isn't a look-alike, like f*ck - add such spellings
   * to the list yourself if you see them.
   */
  badWords: [
    "fuck", "fucking", "fucker", "motherfucker",
    "shit", "bullshit",
    "bitch", "asshole", "bastard",
    "dick", "cunt", "pussy",
    "whore", "slut",
    "nigger", "faggot", "retard",
    // Arabic (starter examples)
    "شرموطة", "متناك", "كسمك", "عرص", "خول",
  ] as string[],

  /**
   * WHERE TO SEND THE LOGS - set ONE of these:
   *   logChannelName: the channel's name, e.g. "mod-logs"   (easiest)
   *   logChannelId:   the channel's ID (wins over the name if both are set)
   * When the bot starts it prints every text channel's name and ID, so you can copy from there.
   * The bot must be able to see and write in that channel.
   */
  logChannelName: "mod-logs",
  logChannelId: "ADGY71GijgSA-QhFN0oE2Q",

  /** Staff who are NOT filtered. Role names (case-insensitive) and/or role IDs. */
  exemptRoleNames: ["Admins"] as string[],
  exemptRoleIds: ["ADGY71GijwuK1K4Q3Q-GUg"] as string[],

  /** Also check messages after they are edited (stops "post clean, edit in a bad word"). */
  checkEdits: true,

  /** Post a short notice in the channel ("Alice, your message was removed...")? */
  notifyUser: true,
  /** ...and delete that notice again after this many milliseconds (0 = leave it). */
  notifyDeleteAfterMs: 8000,

  /** Long messages are cut to this many characters in the log. */
  maxLoggedChars: 1000,

  /** Time zone for the time shown in the log. */
  timeZone: "Africa/Cairo",
};

// -----------------------------------------------------------------------------
//  Text matching
// -----------------------------------------------------------------------------

/** Lower-case, strip accents / Arabic diacritics / invisible characters, unify Arabic letter forms. */
function foldText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "") // invisible characters
    .replace(/[\u0300-\u036F]/g, "") // Latin accents
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // Arabic diacritics + tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

const LEET: Record<string, string> = { "@": "a", "4": "a", "3": "e", "1": "i", "0": "o", "$": "s", "5": "s", "7": "t" };

/**
 * Turns look-alike symbols into letters (sh1t -> shit, @ss -> ass).
 * Only done inside words that already contain a letter, so a plain number like "455" is left alone.
 */
function leetVariant(folded: string): string {
  return folded
    .split(/(\s+)/)
    .map((tok) => (/\p{L}/u.test(tok) ? tok.replace(/[@43105$7]/g, (c) => LEET[c]) : tok))
    .join("");
}

const escapeRegex = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEP = "[\\s._\\-*]"; // characters people put between letters to dodge filters

type CompiledWord = { word: string; regex: RegExp };
let compiledWords: CompiledWord[] | undefined;

function compileWord(word: string): RegExp | undefined {
  const folded = foldText(word).trim();
  if (!folded) return undefined;

  const parts = folded.split(/\s+/).map((part) => {
    const letters = Array.from(part);
    // group runs of the same letter: "ass" -> a{1,}s{2,}  (so "as" doesn't match, "asss" does)
    const runs: string[] = [];
    for (const ch of letters) {
      const last = runs[runs.length - 1];
      if (last && last[0] === ch) runs[runs.length - 1] = last + ch;
      else runs.push(ch);
    }
    const pieces = runs.map((r) => `${escapeRegex(r[0])}{${r.length},}`);
    // words of 4+ letters also match with separators between letters (f u c k, f.u.c.k)
    return pieces.join(letters.length >= 4 ? `${SEP}{0,2}` : "");
  });
  const body = parts.join(`${SEP}+`);
  return new RegExp(`(?<![\\p{L}])${body}(?![\\p{L}])`, "iu");
}

function getCompiledWords(): CompiledWord[] {
  if (!compiledWords) {
    compiledWords = [];
    for (const word of WORD_FILTER.badWords) {
      try {
        const regex = compileWord(word);
        if (regex) compiledWords.push({ word, regex });
      } catch (err) {
        console.warn(`[WordFilter] could not use the word "${word}":`, err);
      }
    }
  }
  return compiledWords;
}

/** Returns which blocked words the text contains (empty array = clean). */
function findBadWords(text: string): string[] {
  if (!text) return [];
  const folded = foldText(text);
  const variants = [folded, leetVariant(folded)];
  const hits: string[] = [];
  for (const { word, regex } of getCompiledWords()) {
    if (variants.some((v) => regex.test(v))) hits.push(word);
  }
  return hits;
}

// -----------------------------------------------------------------------------
//  Helpers
// -----------------------------------------------------------------------------

const wfSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retry when Root says "slow down" (the docs' recommended pattern). */
async function wfRetry<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (err: unknown) {
      const retryable =
        err instanceof RootApiException &&
        (err.errorCode === ErrorCodeType.TooManyRequests ||
          err.errorCode === ErrorCodeType.ServerError ||
          err.errorCode === ErrorCodeType.Timeout ||
          err.errorCode === ErrorCodeType.StillProcessing);
      if (attempt >= maxRetries || !retryable) throw err;
      await wfSleep(Math.random() * Math.min(1000 * 2 ** attempt, 15000));
    }
  }
}

const isBotUser = (userId: string): boolean => {
  try {
    return RootGuidUtils.toRootGuidType(userId) === RootGuidType.App;
  } catch {
    return false;
  }
};

/** Every text channel as { id, name }. */
async function listTextChannels(): Promise<{ id: ChannelGuid; name: string }[]> {
  const result: { id: ChannelGuid; name: string }[] = [];
  const groups = await rootServer.community.channelGroups.list();
  for (const group of groups) {
    try {
      const channels = await rootServer.community.channels.list({ channelGroupId: group.id });
      for (const c of channels) {
        // 1 = Text, 2 = ThreadedText
        if (c.channelType === 1 || c.channelType === 2) result.push({ id: c.id, name: c.name });
      }
    } catch {
      /* a group we can't see - skip it */
    }
  }
  return result;
}

let logChannelCache: { id: ChannelGuid; name: string } | undefined;

/** Finds the log channel from WORD_FILTER.logChannelId / logChannelName. */
async function getLogChannel(): Promise<{ id: ChannelGuid; name: string } | undefined> {
  if (logChannelCache) return logChannelCache;
  const wantedId = WORD_FILTER.logChannelId.trim();
  const wantedName = WORD_FILTER.logChannelName.trim().replace(/^#/, "").toLowerCase();
  if (!wantedId && !wantedName) return undefined;

  const channels = await listTextChannels();
  const found = wantedId
    ? channels.find((c) => c.id === wantedId) ?? { id: wantedId as ChannelGuid, name: "log channel" }
    : channels.find((c) => c.name.toLowerCase() === wantedName);
  if (found) logChannelCache = found;
  return found;
}

async function nicknameOf(userId: UserGuid): Promise<string> {
  try {
    return (await rootServer.community.communityMembers.get({ userId })).nickname || "Unknown user";
  } catch {
    return "Unknown user";
  }
}

async function isExempt(userId: UserGuid): Promise<boolean> {
  try {
    const names = WORD_FILTER.exemptRoleNames.map((n) => n.trim().toLowerCase()).filter(Boolean);
    const roles = await rootServer.community.communityRoles.list();
    const exempt = new Set<string>(WORD_FILTER.exemptRoleIds);
    for (const r of roles) if (names.includes(r.name.trim().toLowerCase())) exempt.add(r.id);
    if (exempt.size === 0) return false;
    const member = await rootServer.community.communityMembers.get({ userId });
    return member.communityRoleIds.some((id) => exempt.has(id));
  } catch {
    return false; // can't verify => filter as normal
  }
}

/** Mentions in message text look like [@Alice](root://user/...). Show just "@Alice" so logging never pings anyone. */
function plainText(content: string): string {
  return content.replace(/\[([^\]]*)\]\(root:\/\/[^)\s]+\)/gi, "$1");
}

function formatLogTime(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: WORD_FILTER.timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(date);
}

// -----------------------------------------------------------------------------
//  The filter
// -----------------------------------------------------------------------------

type FilterEvent = ChannelMessageCreatedEvent | ChannelMessageEditedEvent;

async function filterMessage(evt: FilterEvent, wasEdit: boolean): Promise<void> {
  try {
    if (!WORD_FILTER.enabled) return;
    if (evt.messageType !== MessageType.UserMessage) return;
    if (!evt.userId || isBotUser(evt.userId)) return; // never filter bots (this also stops log loops)

    const content = evt.messageContent ?? "";
    const hits = findBadWords(content);
    if (hits.length === 0) return;

    // Only now (a bad word was found) do the slower checks.
    const logChannel = await getLogChannel().catch(() => undefined);
    if (logChannel && evt.channelId === logChannel.id) return; // don't police the log channel itself
    if (await isExempt(evt.userId)) return;

    // 1. Delete the message
    let deleteNote = "";
    try {
      await wfRetry(() => rootServer.community.channelMessages.delete({ channelId: evt.channelId, id: evt.id }));
    } catch (err) {
      deleteNote =
        err instanceof RootApiException
          ? `Could NOT delete the message (${ErrorCodeType[err.errorCode] ?? err.errorCode}) - check the bot's "delete messages" permission.`
          : "Could NOT delete the message.";
      console.error("[WordFilter] delete failed:", err);
    }

    // 2. Log it
    const name = await nicknameOf(evt.userId);
    if (logChannel) {
      let channelName = "unknown channel";
      try {
        channelName = (await rootServer.community.channels.get({ id: evt.channelId })).name;
      } catch {
        /* keep the fallback */
      }

      let text = plainText(content);
      if (text.length > WORD_FILTER.maxLoggedChars) text = text.slice(0, WORD_FILTER.maxLoggedChars) + " ... (cut)";
      const quoted = text.split("\n").map((l) => `> ${l}`).join("\n");

      const lines = [
        `🚫 **Message removed - blocked word${wasEdit ? " (after edit)" : ""}**`,
        `**User:** ${name} (id: ${evt.userId})`,
        `**Channel:** #${channelName}`,
        `**Matched:** ${hits.join(", ")}`,
        `**Time:** ${formatLogTime(new Date())}`,
        `**Message:**`,
        quoted,
      ];
      if (deleteNote) lines.push(`⚠️ ${deleteNote}`);

      try {
        await wfRetry(() =>
          rootServer.community.channelMessages.create({ channelId: logChannel.id, content: lines.join("\n") })
        );
      } catch (err) {
        console.error("[WordFilter] could not write to the log channel (can the bot see and post there?):", err);
      }
    } else {
      console.warn(
        `[WordFilter] removed a message from ${name} but no log channel is set/found. ` +
          `Set WORD_FILTER.logChannelName or logChannelId in autorole.ts.`
      );
    }

    // 3. Tell the user (short-lived notice)
    if (WORD_FILTER.notifyUser && !deleteNote) {
      try {
        const notice = await wfRetry(() =>
          rootServer.community.channelMessages.create({
            channelId: evt.channelId,
            content: `${name}, your message was removed because it contained a blocked word.`,
          })
        );
        if (WORD_FILTER.notifyDeleteAfterMs > 0) {
          setTimeout(() => {
            rootServer.community.channelMessages
              .delete({ channelId: notice.channelId, id: notice.id })
              .catch(() => undefined);
          }, WORD_FILTER.notifyDeleteAfterMs);
        }
      } catch (err) {
        console.warn("[WordFilter] could not post the notice:", err);
      }
    }

    console.log(`[WordFilter] removed a message from ${name} (matched: ${hits.join(", ")})`);
  } catch (err) {
    // Never let an exception escape an event handler - Root restarts the bot if it does.
    console.error("[WordFilter] unexpected error:", err);
  }
}

/** Used by leveling.ts so deleted messages don't earn XP. */
export function containsBlockedWord(text: string): boolean {
  return WORD_FILTER.enabled && findBadWords(text).length > 0;
}

function initializeWordFilter(): void {
  if (!WORD_FILTER.enabled) {
    console.log("[WordFilter] disabled.");
    return;
  }
  rootServer.community.channelMessages.on(ChannelMessageEvent.ChannelMessageCreated, (evt) => {
    void filterMessage(evt, false);
  });
  if (WORD_FILTER.checkEdits) {
    rootServer.community.channelMessages.on(ChannelMessageEvent.ChannelMessageEdited, (evt) => {
      void filterMessage(evt, true);
    });
  }

  // Startup report: is the log channel found? plus every text channel's name + ID to copy from.
  void (async () => {
    try {
      console.log(`[WordFilter] active with ${getCompiledWords().length} blocked words.`);
      const channels = await listTextChannels();
      const log = await getLogChannel();
      if (log) console.log(`[WordFilter] log channel: #${log.name} (${log.id})`);
      else
        console.warn(
          "[WordFilter] WARNING: log channel not found. Messages will still be deleted but NOT logged. " +
            "Set logChannelName / logChannelId in autorole.ts. Text channels I can see:"
        );
      for (const c of channels) console.log(`   #${c.name}  ->  ${c.id}`);
    } catch (err) {
      console.warn("[WordFilter] startup check failed:", err);
    }
  })();
}
