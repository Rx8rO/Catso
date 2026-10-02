"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeBotFeatures = initializeBotFeatures;
const server_bot_1 = require("@rootsdk/server-bot");
let memberRoleId;
function initializeBotFeatures(state) {
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
    server_bot_1.rootServer.community.channelMessages.on(server_bot_1.ChannelMessageEvent.ChannelMessageCreated, onMessage);
}
async function onMessage(evt) {
    try {
        // If it's a system message, log the whole object to see how joins are represented
        if (evt.messageType === server_bot_1.MessageType.System) {
            console.log("Full system message event object:", JSON.stringify(evt, null, 2));
            // Attempt to extract user ID from standard system payload fields
            const targetUserId = evt.userId || evt.targetUserId || evt.authorId;
            const systemText = evt.messageContent || "";
            if (targetUserId) {
                console.log(`-> Detected system event target user ID: ${targetUserId}`);
                await assignMemberRole(targetUserId);
            }
            return;
        }
        // Normal chat messages ("meow")
        const messageText = evt.messageContent || evt.content || evt.text || "";
        console.log(`[Message Received]: "${messageText}"`);
        if (messageText.trim().toLowerCase() === "meow") {
            console.log("-> Matched 'meow'! Replying...");
            await server_bot_1.rootServer.community.channelMessages.create({
                channelId: evt.channelId,
                content: "stfu gang",
            });
        }
    }
    catch (xcpt) {
        handleError(xcpt);
    }
}
async function assignMemberRole(userId) {
    if (!memberRoleId) {
        console.warn("⚠️ Cannot assign role, memberRoleId is undefined!");
        return;
    }
    const request = {
        communityRoleId: memberRoleId,
        userIds: [userId],
    };
    await server_bot_1.rootServer.community.communityMemberRoles.add(request);
    console.log(`Successfully assigned Member role to user ${userId}`);
}
function handleError(xcpt) {
    if (xcpt instanceof server_bot_1.RootApiException) {
        switch (xcpt.errorCode) {
            case server_bot_1.ErrorCodeType.TooManyRequests:
                console.error("Rate limited — commands max ~5 req/s");
                break;
            default:
                console.error("RootApiException:", xcpt.errorCode);
        }
    }
    else if (xcpt instanceof Error) {
        console.error("Unexpected error:", xcpt.message);
    }
}
