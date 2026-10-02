"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const server_bot_1 = require("@rootsdk/server-bot");
const autorole_1 = require("./autorole");
const commands_1 = require("./commands");
const moderation_1 = require("./moderation");
const leveling_1 = require("./leveling");
async function onStarting(state) {
    // Initialize all your bot feature modules here
    (0, autorole_1.initializeBotFeatures)(state);
    (0, commands_1.initializeCommands)();
    (0, moderation_1.initializeModeration)();
    (0, leveling_1.initializeLeveling)();
}
(async () => {
    await server_bot_1.rootServer.lifecycle.start(onStarting);
})();
