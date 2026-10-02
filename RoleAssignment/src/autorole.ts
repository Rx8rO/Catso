import {
  rootServer,
  RootApiException,
  ErrorCodeType,
  RootBotStartState,
  MessageType,
  ChannelMessageEvent,
  ChannelMessageCreatedEvent,
  CommunityMemberRoleAddRequest,
  CommunityRoleGuid,
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