"use strict";
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
//    !role add    @user <@role | role name>
//    !role remove @user <@role | role name>
//    !roles
//
//  SECURITY: every command is locked to members who hold one of the staff roles
//  configured in CONFIG below. Everyone else is ignored (or told "no permission",
//  see CONFIG.replyWhenDenied). If no staff role can be found the bot FAILS
//  CLOSED: nobody can use any command.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeModeration = initializeModeration;
exports.logModerationStatus = logModerationStatus;
const server_bot_1 = require("@rootsdk/server-bot");
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
    staffRoleNames: ["Admins"],
    staffRoleIds: [ADGY71GijwuK1K4Q3Q - GUg],
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
};
// -----------------------------------------------------------------------------
//  Small utilities
// -----------------------------------------------------------------------------
/** An error whose message is safe/intended to show to the user in chat. */
class UserError extends Error {
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Retry on rate-limit / transient errors (pattern from the Root docs). */
async function withRetry(operation, maxRetries = 3) {
    for (let attempt = 0;; attempt++) {
        try {
            return await operation();
        }
        catch (err) {
            const retryable = err instanceof server_bot_1.RootApiException
                ? err.errorCode === server_bot_1.ErrorCodeType.TooManyRequests ||
                    err.errorCode === server_bot_1.ErrorCodeType.ServerError ||
                    err.errorCode === server_bot_1.ErrorCodeType.Timeout ||
                    err.errorCode === server_bot_1.ErrorCodeType.StillProcessing
                : false;
            if (attempt >= maxRetries || !retryable)
                throw err;
            const cap = Math.min(1000 * 2 ** attempt, 15000);
            await sleep(Math.random() * cap);
        }
    }
}
/** Turn any thrown error into a friendly one-line message. */
function describeError(err) {
    if (err instanceof UserError)
        return err.message;
    if (err instanceof server_bot_1.RootApiException) {
        switch (err.errorCode) {
            case server_bot_1.ErrorCodeType.NoPermissionToKick:
                return "I don't have the Kick permission (or that member outranks me).";
            case server_bot_1.ErrorCodeType.NoPermissionToBan:
                return "I don't have the Ban permission (or that member outranks me).";
            case server_bot_1.ErrorCodeType.NoPermissionToDelete:
                return "I don't have permission to delete messages here.";
            case server_bot_1.ErrorCodeType.NoPermissionToAdd:
            case server_bot_1.ErrorCodeType.NoPermissionToEdit:
                return "I don't have permission to manage roles (or that role is above my own role).";
            case server_bot_1.ErrorCodeType.NoPermissionToCreate:
            case server_bot_1.ErrorCodeType.NoPermissionToRead:
                return "I'm missing a permission needed for that.";
            case server_bot_1.ErrorCodeType.NotFound:
                return "I couldn't find that member, role or ban.";
            case server_bot_1.ErrorCodeType.AlreadyExists:
                return "That already exists (e.g. the user is already banned).";
            case server_bot_1.ErrorCodeType.RequestedSelf:
                return "I can't do that to myself.";
            case server_bot_1.ErrorCodeType.TooManyRequests:
                return "I'm being rate limited. Try again in a moment.";
            default:
                return `Root API error: ${server_bot_1.ErrorCodeType[err.errorCode] ?? err.errorCode}.`;
        }
    }
    return "Something went wrong.";
}
// -----------------------------------------------------------------------------
//  Sending replies
// -----------------------------------------------------------------------------
/** Reply text must NEVER start with the prefix, or the bot could trigger itself. */
function safeText(text) {
    return text.startsWith(CONFIG.prefix) ? "\u200B" + text : text;
}
async function reply(evt, text, transient = false) {
    try {
        const sent = await withRetry(() => server_bot_1.rootServer.community.channelMessages.create({ channelId: evt.channelId, content: safeText(text) }));
        if (transient && CONFIG.autoDeleteConfirmationsMs > 0) {
            setTimeout(() => {
                server_bot_1.rootServer.community.channelMessages
                    .delete({ channelId: sent.channelId, id: sent.id })
                    .catch(() => undefined);
            }, CONFIG.autoDeleteConfirmationsMs);
        }
    }
    catch (err) {
        console.error("[moderation] failed to send reply:", err);
    }
}
// -----------------------------------------------------------------------------
//  Staff / permission gate
// -----------------------------------------------------------------------------
/** Role IDs that count as "staff", resolved from CONFIG against the live role list. */
async function resolveStaffRoleIds() {
    const roles = await server_bot_1.rootServer.community.communityRoles.list();
    const ids = new Set(CONFIG.staffRoleIds);
    const names = CONFIG.staffRoleNames.map((n) => n.trim().toLowerCase()).filter(Boolean);
    const result = new Set();
    for (const role of roles) {
        if (ids.has(role.id) || names.includes(role.name.trim().toLowerCase()))
            result.add(role.id);
    }
    return result;
}
async function isStaff(userId, staffRoles) {
    const staff = staffRoles ?? (await resolveStaffRoleIds());
    if (staff.size === 0)
        return false; // fail closed
    try {
        const member = await server_bot_1.rootServer.community.communityMembers.get({ userId });
        return member.communityRoleIds.some((id) => staff.has(id));
    }
    catch {
        return false; // can't verify => deny
    }
}
// Root encodes mentions in message text as:  [@Alice](root://user/<id>)
const MENTION_RE = /\[([^\]]*)\]\(root:\/\/(user|role|channel)\/([^)\s]+)\)/gi;
const MARK = "\u0001";
function parseArgs(content) {
    const mentions = [];
    const replaced = content.replace(MENTION_RE, (_m, label, kind, id) => {
        mentions.push({ kind: kind.toLowerCase(), id, label });
        return ` ${MARK}${mentions.length - 1}${MARK} `;
    });
    return replaced
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((tok) => {
        const m = /^\u0001(\d+)\u0001$/.exec(tok);
        return m ? { type: "mention", mention: mentions[Number(m[1])] } : { type: "word", text: tok };
    });
}
/** Text of the remaining args (mentions are shown by their label). */
function argsToText(args) {
    return args.map((a) => (a.type === "word" ? a.text : a.mention.label)).join(" ").trim();
}
function looksLikeUserGuid(s) {
    if (!/^[A-Za-z0-9_-]{22}$/.test(s))
        return false;
    try {
        const t = server_bot_1.RootGuidUtils.toRootGuidType(s);
        return t === server_bot_1.RootGuidType.Person || t === server_bot_1.RootGuidType.App;
    }
    catch {
        return false;
    }
}
/** Find (and remove) the first user in args: an @mention, or a raw user ID. */
function extractUser(args) {
    const i = args.findIndex((a) => (a.type === "mention" && a.mention.kind === "user") || (a.type === "word" && looksLikeUserGuid(a.text)));
    if (i < 0)
        return undefined;
    const [a] = args.splice(i, 1);
    return a.type === "mention"
        ? { userId: a.mention.id, label: a.mention.label.replace(/^@/, "") }
        : { userId: a.text };
}
/** Find (and remove) the first @role mention in args. */
function extractRoleMention(args) {
    const i = args.findIndex((a) => a.type === "mention" && a.mention.kind === "role");
    if (i < 0)
        return undefined;
    const [a] = args.splice(i, 1);
    return a.type === "mention" ? a.mention : undefined;
}
/** "30m", "12h", "7d", "2w"  ->  milliseconds */
function parseDuration(token) {
    const m = /^(\d+)([mhdw])$/i.exec(token);
    if (!m)
        return undefined;
    const n = Number(m[1]);
    const unit = { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[m[2].toLowerCase()];
    return n > 0 ? n * unit : undefined;
}
// -----------------------------------------------------------------------------
//  Helpers that talk to Root
// -----------------------------------------------------------------------------
async function displayName(userId, hint) {
    if (hint)
        return hint;
    try {
        const m = await server_bot_1.rootServer.community.communityMembers.get({ userId });
        return m.nickname || "that user";
    }
    catch {
        return "that user";
    }
}
function requireUser(args, usage) {
    const u = extractUser(args);
    if (!u)
        throw new UserError(`Please mention a user. Usage: ${usage}`);
    return u;
}
async function guardTarget(executor, target) {
    if (target === executor)
        throw new UserError("You can't do that to yourself.");
    if (CONFIG.protectStaff && (await isStaff(target))) {
        throw new UserError("You can't do that to another staff member.");
    }
}
/** Find a role from an @role mention or a typed name (case-insensitive). */
async function resolveRole(args, usage) {
    const roles = await server_bot_1.rootServer.community.communityRoles.list();
    const mention = extractRoleMention(args);
    let role;
    if (mention) {
        role = roles.find((r) => r.id === mention.id);
        if (!role)
            role = roles.find((r) => r.name.toLowerCase() === mention.label.replace(/^@/, "").toLowerCase());
    }
    else {
        const typed = argsToText(args).replace(/^["'“”]+|["'“”]+$/g, "").replace(/^@/, "").trim().toLowerCase();
        if (!typed)
            throw new UserError(`Please give a role. Usage: ${usage}`);
        role = roles.find((r) => r.name.toLowerCase() === typed);
        if (!role) {
            const partial = roles.filter((r) => r.name.toLowerCase().startsWith(typed));
            if (partial.length === 1)
                role = partial[0];
            else if (partial.length > 1)
                throw new UserError(`Several roles match "${typed}": ${partial.map((r) => r.name).join(", ")}. Be more specific.`);
        }
    }
    if (!role)
        throw new UserError("I couldn't find that role. Use !roles to see the list.");
    if (role.id === server_bot_1.WellKnownRootGuids.CommunityRoles.EveryoneRole)
        throw new UserError("The @everyone role can't be added or removed.");
    return role;
}
const P = CONFIG.prefix;
const COMMANDS = {
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
            await withRetry(() => server_bot_1.rootServer.community.communityMemberBans.kick({ userId: target.userId }));
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
            let expiresAt;
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
            await withRetry(() => server_bot_1.rootServer.community.communityMemberBans.create({
                userId: target.userId,
                ...(reason ? { reason } : {}),
                ...(expiresAt ? { expiresAt } : {}),
            }));
            await reply(evt, `Banned ${name} ${durationText}${reason ? ` - ${reason}` : ""}.`);
        },
    },
    // ---------------------------------------------------------------- unban
    unban: {
        description: "Unban a member",
        run: async ({ evt, args }) => {
            const target = requireUser(args, `${P}unban @user  (or ${P}unban <userId> - see ${P}bans)`);
            await withRetry(() => server_bot_1.rootServer.community.communityMemberBans.delete({ userId: target.userId }));
            await reply(evt, `Unbanned ${target.label ?? target.userId}.`);
        },
    },
    // ---------------------------------------------------------------- bans
    bans: {
        description: "List banned users",
        run: async ({ evt }) => {
            const bans = await server_bot_1.rootServer.community.communityMemberBans.list();
            if (bans.length === 0)
                return reply(evt, "No one is banned.");
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
            if (!Number.isInteger(count) || count < 1)
                throw new UserError(`Please give a number. Usage: ${usage}`);
            if (count > CONFIG.maxPurge)
                throw new UserError(`The maximum per purge is ${CONFIG.maxPurge}.`);
            // Remove the staff member's command message first so it isn't in the way.
            await server_bot_1.rootServer.community.channelMessages.delete({ channelId: evt.channelId, id: evt.id }).catch(() => undefined);
            const deleted = await purgeMessages(evt, count, onlyUser?.userId);
            const who = onlyUser ? ` from ${onlyUser.label ?? "that user"}` : "";
            await reply(evt, `Purged ${deleted} message${deleted === 1 ? "" : "s"}${who}.`, true);
        },
    },
    // ---------------------------------------------------------------- role add / remove
    role: {
        description: "Add or remove a role from a member",
        run: async ({ evt, args }) => {
            const usage = `${P}role add @user <@role | role name>   or   ${P}role remove @user <@role | role name>`;
            const sub = args[0] && args[0].type === "word" ? args[0].text.toLowerCase() : "";
            if (sub !== "add" && sub !== "remove")
                throw new UserError(`Usage: ${usage}`);
            args.shift();
            const target = requireUser(args, usage);
            const role = await resolveRole(args, usage);
            const name = await displayName(target.userId, target.label);
            let current;
            try {
                current = (await server_bot_1.rootServer.community.communityMembers.get({ userId: target.userId })).communityRoleIds;
            }
            catch {
                throw new UserError("I couldn't find that member in this community.");
            }
            const has = current.includes(role.id);
            if (sub === "add") {
                if (has)
                    throw new UserError(`${name} already has the ${role.name} role.`);
                await withRetry(() => server_bot_1.rootServer.community.communityMemberRoles.add({ communityRoleId: role.id, userIds: [target.userId] }));
                await reply(evt, `Added the ${role.name} role to ${name}.`);
            }
            else {
                if (!has)
                    throw new UserError(`${name} doesn't have the ${role.name} role.`);
                await withRetry(() => server_bot_1.rootServer.community.communityMemberRoles.remove({ communityRoleId: role.id, userIds: [target.userId] }));
                await reply(evt, `Removed the ${role.name} role from ${name}.`);
            }
        },
    },
    // ---------------------------------------------------------------- roles
    roles: {
        description: "List roles and their IDs",
        run: async ({ evt }) => {
            const roles = await server_bot_1.rootServer.community.communityRoles.list();
            const lines = roles
                .filter((r) => r.id !== server_bot_1.WellKnownRootGuids.CommunityRoles.EveryoneRole)
                .map((r) => `- ${r.name}  (id: ${r.id})`);
            await reply(evt, lines.length ? `**Roles**\n${lines.join("\n")}` : "There are no roles yet.");
        },
    },
};
// -----------------------------------------------------------------------------
//  Purge implementation
// -----------------------------------------------------------------------------
const PAGE = 50;
async function listRecent(channelId, limit) {
    const res = await withRetry(() => server_bot_1.rootServer.community.channelMessages.list({
        channelId,
        messageDirectionTake: server_bot_1.MessageDirectionTake.Older,
        dateAt: new Date(Date.now() + 60000), // "now" (slightly ahead to include the newest message)
        limit,
    }));
    // newest first
    return res.messages
        .filter((m) => !m.deletedAt)
        .sort((a, b) => server_bot_1.RootGuidUtils.toMilliseconds(b.id) - server_bot_1.RootGuidUtils.toMilliseconds(a.id));
}
async function purgeMessages(evt, count, onlyUser) {
    let deleted = 0;
    const deleteOne = async (m) => {
        try {
            await withRetry(() => server_bot_1.rootServer.community.channelMessages.delete({ channelId: m.channelId, id: m.id }));
            deleted++;
            return true;
        }
        catch (err) {
            // Permission problems will fail every delete - surface that instead of silently stopping.
            if (err instanceof server_bot_1.RootApiException && err.errorCode === server_bot_1.ErrorCodeType.NoPermissionToDelete)
                throw err;
            console.warn("[moderation] could not delete a message:", err);
            return false;
        }
        finally {
            await sleep(250); // pace to ~4 deletes/sec (limit is ~5/sec)
        }
    };
    if (onlyUser) {
        // One scan of the most recent messages, delete the first `count` that belong to that user.
        const recent = await listRecent(evt.channelId, CONFIG.purgeUserScanLimit);
        for (const m of recent.filter((x) => x.userId === onlyUser).slice(0, count))
            await deleteOne(m);
        return deleted;
    }
    // No user filter: repeatedly fetch the newest messages and delete them.
    while (deleted < count) {
        const batch = (await listRecent(evt.channelId, Math.min(PAGE, count - deleted))).slice(0, count - deleted);
        if (batch.length === 0)
            break;
        const before = deleted;
        for (const m of batch)
            await deleteOne(m);
        if (deleted === before)
            break; // nothing could be deleted - avoid looping forever
    }
    return deleted;
}
// -----------------------------------------------------------------------------
//  Message handler (the gate lives here)
// -----------------------------------------------------------------------------
async function onMessage(evt) {
    try {
        // Only real user/bot messages - never system messages.
        if (evt.messageType !== server_bot_1.MessageType.UserMessage)
            return;
        const content = (evt.messageContent ?? "").trim();
        if (!content.startsWith(CONFIG.prefix))
            return;
        const args = parseArgs(content.slice(CONFIG.prefix.length));
        const first = args.shift();
        if (!first || first.type !== "word")
            return;
        const command = COMMANDS[first.text.toLowerCase()];
        if (!command)
            return; // not one of ours - ignore silently
        // ---- THE GATE: only staff may use any command -------------------------
        const staffRoles = await resolveStaffRoleIds();
        if (!(await isStaff(evt.userId, staffRoles))) {
            if (CONFIG.replyWhenDenied) {
                await reply(evt, "You don't have permission to use moderation commands.", true);
            }
            return;
        }
        // ------------------------------------------------------------------------
        try {
            await command.run({ evt, args });
        }
        catch (err) {
            if (!(err instanceof UserError))
                console.error(`[moderation] ${first.text} failed:`, err);
            await reply(evt, describeError(err), true);
        }
        if (CONFIG.deleteCommandMessages && first.text.toLowerCase() !== "purge") {
            server_bot_1.rootServer.community.channelMessages.delete({ channelId: evt.channelId, id: evt.id }).catch(() => undefined);
        }
    }
    catch (err) {
        // Never let an exception escape an event handler - Root restarts the bot if it does.
        console.error("[moderation] unhandled error:", err);
    }
}
// -----------------------------------------------------------------------------
//  Public entry point
// -----------------------------------------------------------------------------
/** Call once from main.ts, before/at startup. */
function initializeModeration() {
    server_bot_1.rootServer.community.channelMessages.on(server_bot_1.ChannelMessageEvent.ChannelMessageCreated, onMessage);
}
/** Call from your starting callback: logs which roles are staff, and warns if none match. */
async function logModerationStatus() {
    try {
        const roles = await server_bot_1.rootServer.community.communityRoles.list();
        const staff = await resolveStaffRoleIds();
        if (staff.size === 0) {
            console.warn("[moderation] WARNING: no staff role matched CONFIG.staffRoleNames / staffRoleIds. " +
                "NOBODY can use moderation commands until you fix this.");
        }
        else {
            const names = roles.filter((r) => staff.has(r.id)).map((r) => `${r.name} (${r.id})`);
            console.log(`[moderation] ready. Staff roles: ${names.join(", ")}`);
        }
        console.log("[moderation] roles in this community:");
        for (const r of roles)
            console.log(`   ${r.name}  ->  ${r.id}`);
    }
    catch (err) {
        console.error("[moderation] could not read roles at startup:", err);
    }
}
