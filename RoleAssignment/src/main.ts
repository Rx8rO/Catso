import { rootServer, RootBotStartState } from "@rootsdk/server-bot";
import { initializeBotFeatures } from "./autorole";
import { initializeCommands } from "./commands";
import { initializeModeration } from "./moderation";
import { initializeLeveling } from "./leveling";

async function onStarting(state: RootBotStartState) {
  // Initialize all your bot feature modules here
  initializeBotFeatures(state);
  initializeCommands();
  initializeModeration();
  initializeLeveling();
}

(async () => {
  await rootServer.lifecycle.start(onStarting);
})();