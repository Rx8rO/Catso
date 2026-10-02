/** Call once from main.ts, before/at startup. */
export declare function initializeModeration(): void;
/** Call from your starting callback: logs which roles are staff, and warns if none match. */
export declare function logModerationStatus(): Promise<void>;
