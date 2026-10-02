import { trackMessage } from "./moderation";
import fs from "fs";
import path from "path";
import { Buffer } from "buffer";
import {
  rootServer,
  ChannelMessageEvent,
  ChannelMessageCreatedEvent,
  MessageType,
  UserGuid,
  CommunityMemberRoleAddRequest,
} from "@rootsdk/server-bot";

// --- CONFIGURATION ---
const CITIZEN_ROLE_ID = "ADGZqTnviQukWZkoHva60w";
const ADMIN_USER_IDS = ["ADGYsgGShAGhfotVUqY60Q"]; // Your Admin ID

// Level to Role Mapping
const LEVEL_ROLES: Record<number, string> = {
  2: CITIZEN_ROLE_ID, // Grants Citizen role at Level 2
};

const COOLDOWN_SECONDS = 3; // XP cooldown per user
const XP_PER_MESSAGE_MIN = 50;
const XP_PER_MESSAGE_MAX = 100;
const LEVELS_FILE = path.join(process.cwd(), "levels.json");

interface UserLevelData {
  xp: number;
  level: number;
  lastXpTimestamp: number;
}

// User ID -> Level Data
let userLevels = new Map<string, UserLevelData>();

// --- PERSISTENCE HELPERS ---
function loadLevels(): void {
  try {
    if (fs.existsSync(LEVELS_FILE)) {
      const raw = fs.readFileSync(LEVELS_FILE, "utf-8");
      const data = JSON.parse(raw);
      userLevels = new Map(Object.entries(data));
      console.log("[Leveling] Successfully loaded user levels from disk.");
    }
  } catch (err) {
    console.error("[Leveling] Failed to load levels from disk:", err);
  }
}

function saveLevels(): void {
  try {
    const obj = Object.fromEntries(userLevels);
    fs.writeFileSync(LEVELS_FILE, JSON.stringify(obj, null, 2), "utf-8");
  } catch (err) {
    console.error("[Leveling] Failed to save levels to disk:", err);
  }
}

// --- XP FORMULA ---
function getXpNeededForLevel(level: number): number {
  return level * 100;
}

// --- ID CONVERSION HELPER ---
// Converts a standard UUID into the 22-character Base64url ID used by the database
function uuidToShortId(uuid: string): string {
  const hex = uuid.replace(/-/g, '');
  const base64 = Buffer.from(hex, 'hex').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- INITIALIZER ---
export function initializeLeveling(): void {
  loadLevels();
  rootServer.community.channelMessages.on(
    ChannelMessageEvent.ChannelMessageCreated,
    onLevelingMessage
  );
  console.log("Leveling System initialized with Auto-Role Assignment!");
}

// --- MAIN EVENT HANDLER ---
async function onLevelingMessage(evt: ChannelMessageCreatedEvent): Promise<void> {
  try {
    if (evt.messageType === MessageType.System) return;

    const text = ((evt as any).messageContent || "").trim();
    const userId = evt.userId;

    if (!userId) return;

    // 1. Handle Leveling Commands first
    if (text.startsWith("!rank") || text.startsWith("!level")) {
      await handleRankCommand(evt, text);
      return;
    } else if (text === "!leaderboard" || text === "!lb") {
      await handleLeaderboardCommand(evt);
      return;
    } else if (text.startsWith("!reset") || text.startsWith("!resetlevel")) {
      await handleResetCommand(evt, text);
      return;
    }

    // Ignore command triggers from awarding XP
    if (text.startsWith("!")) return;

    // 2. Process XP Gain
    await processXpGain(evt, userId as any);
  } catch (error) {
    console.error("[Leveling] Error processing message:", error);
  }
}

// --- XP PROCESSING & LEVEL UP ---
async function processXpGain(evt: ChannelMessageCreatedEvent, userId: string): Promise<void> {
  const now = Date.now();
  let userData = userLevels.get(userId) || {
    xp: 0,
    level: 1,
    lastXpTimestamp: 0,
  };

  // Cooldown check
  if (now - userData.lastXpTimestamp < COOLDOWN_SECONDS * 1000) {
    return;
  }

  // Grant random XP
  const xpGained =
    Math.floor(Math.random() * (XP_PER_MESSAGE_MAX - XP_PER_MESSAGE_MIN + 1)) +
    XP_PER_MESSAGE_MIN;

  userData.xp += xpGained;
  userData.lastXpTimestamp = now;

  let xpForNext = getXpNeededForLevel(userData.level);
  let leveledUp = false;

  while (userData.xp >= xpForNext) {
    userData.xp -= xpForNext;
    userData.level += 1;
    leveledUp = true;
    xpForNext = getXpNeededForLevel(userData.level);
  }

  userLevels.set(userId, userData);
  saveLevels();

  if (leveledUp) {
    console.log(`[Leveling] User ${userId} reached Level ${userData.level}!`);
    await respond(
      evt,
      `🎉 Congratulations! You leveled up to **Level ${userData.level}**!`
    );

    const communityId = (evt.communityId as string) || "";
    await checkAndAssignRoleReward(communityId, userId, userData.level, evt);
  }
}

// --- ROLE REWARD ASSIGNMENT ---
async function checkAndAssignRoleReward(
  communityId: string,
  userId: string,
  newLevel: number,
  evt: ChannelMessageCreatedEvent
): Promise<void> {
  const roleId = LEVEL_ROLES[newLevel];
  if (!roleId || roleId === "YOUR_CITIZEN_ROLE_ID_HERE") return;

  try {
    const request: CommunityMemberRoleAddRequest = {
      communityRoleId: roleId as any,
      userIds: [userId as UserGuid],
    };

    await rootServer.community.communityMemberRoles.add(request);

    await respond(
      evt,
      `🏅 You reached Level ${newLevel} and earned the **Citizen** role!`
    );
    console.log(`[Leveling] Successfully granted Citizen role to user ${userId}`);
  } catch (err: any) {
    if (err?.code === "ALREADY_EXISTS") {
      console.log(`[Leveling] User ${userId} already has role ${roleId}.`);
      await respond(
        evt,
        `🏅 You reached Level ${newLevel} (Citizen role already assigned)!`
      );
    } else {
      console.error(`[Leveling] Failed to assign role ${roleId} to user ${userId}:`, err);
    }
  }
}

// --- COMMANDS ---
async function handleRankCommand(evt: ChannelMessageCreatedEvent, text: string): Promise<void> {
  const args = text.trim().split(/\s+/);
  let targetId: string = evt.userId as any; 
  let displayName = "User";

  // If a mention exists in the command
  if (args[1]) {
    // Attempt to extract the UUID from the markdown link
    const uuidMatch = args[1].match(/root:\/\/user\/([a-fA-F0-9-]+)/);
    if (uuidMatch && uuidMatch[1]) {
      targetId = uuidToShortId(uuidMatch[1]); // Convert it back to database format
    } else {
      targetId = args[1].replace(/[<@>]/g, "");
    }

    // Try to extract their readable username to make the message look nice
    const nameMatch = args[1].match(/\[@([^\]]+)\]/);
    if (nameMatch && nameMatch[1]) {
      displayName = nameMatch[1];
    }
  }

  const userData = userLevels.get(targetId) || { xp: 0, level: 1, lastXpTimestamp: 0 };
  const needed = getXpNeededForLevel(userData.level);
  
  const isSelf = targetId === (evt.userId as any);
  const title = isSelf ? `📊 **Your Level Status**` : `📊 **Level Status for @${displayName}**`;

  await respond(
    evt,
    `${title}\n` +
      `• **Level:** ${userData.level}\n` +
      `• **Current XP:** ${userData.xp} / ${needed} XP\n` +
      `• **Next Level In:** ${needed - userData.xp} XP`
  );
}

async function handleLeaderboardCommand(evt: ChannelMessageCreatedEvent): Promise<void> {
  if (userLevels.size === 0) {
    await respond(evt, "🏆 Leaderboard is currently empty.");
    return;
  }

  const sorted = Array.from(userLevels.entries()).sort((a, b) => {
    if (b[1].level !== a[1].level) return b[1].level - a[1].level;
    return b[1].xp - a[1].xp;
  });

  const top = sorted.slice(0, 5);
  let leaderboardText = "🏆 **Top Members Leaderboard**\n";

  top.forEach(([uid, data], index) => {
    leaderboardText += `${index + 1}. Member — **Level ${data.level}** (${data.xp} XP)\n`;
  });

  await respond(evt, leaderboardText);
}

async function handleResetCommand(evt: ChannelMessageCreatedEvent, text: string): Promise<void> {
  const senderId: string = evt.userId as any;

  // 1. Check if the user is an admin
  if (!ADMIN_USER_IDS.includes(senderId)) {
    await respond(evt, "❌ You do not have permission to reset levels.");
    return;
  }

  const args = text.trim().split(/\s+/);
  let targetId: string = senderId;
  let displayName = "User";

  // 2. Extract mentioned user's ID
  if (args[1]) {
    const uuidMatch = args[1].match(/root:\/\/user\/([a-fA-F0-9-]+)/);
    if (uuidMatch && uuidMatch[1]) {
      targetId = uuidToShortId(uuidMatch[1]);
    } else {
      targetId = args[1].replace(/[<@>]/g, "");
    }

    const nameMatch = args[1].match(/\[@([^\]]+)\]/);
    if (nameMatch && nameMatch[1]) {
      displayName = nameMatch[1];
    }
  }

  // 3. Reset the level
  userLevels.set(targetId, {
    xp: 0,
    level: 1,
    lastXpTimestamp: 0,
  });
  saveLevels();

  const isSelf = targetId === senderId;
  const message = isSelf 
    ? `🔄 Your level has been reset to **Level 1** (0 XP).` 
    : `🔄 Level for **@${displayName}** has been reset to **Level 1** (0 XP).`;

  await respond(evt, message);
  console.log(`[Leveling] Reset level data for user ${targetId} by admin ${senderId}`);
}

// Helper to send messages 
async function respond(evt: ChannelMessageCreatedEvent, content: string): Promise<void> {
  const res = await rootServer.community.channelMessages.create({
    channelId: evt.channelId,
    content,
    parentMessageIds: [evt.id],
  } as any);

  if (res) {
    const msgId = (res as any).id || (res as any).messageId;
    if (msgId) {
      trackMessage(evt.channelId, msgId);
    }
  }
}