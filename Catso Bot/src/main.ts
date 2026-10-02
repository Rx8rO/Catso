import { rootServer, RootBotStartState } from "@rootsdk/server-bot";
import { initializeBotFeatures } from "./autorole";
import { initializeCommands } from "./commands";
import { initializeModeration, logModerationStatus } from "./moderation";
import { initializeLeveling } from "./leveling";

async function onStarting(state: RootBotStartState) {
  // Initialize all your bot feature modules here
  initializeBotFeatures(state);
  initializeCommands();
  initializeModeration();
  initializeLeveling();

  // Prints which roles count as staff (and every role ID) in the startup log
  await logModerationStatus();
}

async function onStopping() {
  // Nothing to clean up: leveling saves to disk after every XP change.
}

(async () => {
  await rootServer.lifecycle.start(onStarting, onStopping);
})();
