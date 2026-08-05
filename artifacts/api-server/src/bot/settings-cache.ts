import { db, settingsTable } from "@workspace/db";

export interface BotSettings {
  startMessage: string;
  startMessageEntities: string;
  startButtons: string;
  subscriptionMessage: string;
  subscriptionMessageEntities: string;
  fixedButtonsMessage: string;
  fixedButtonsMessageEntities: string;
  contentProtection: boolean;
}

export const DEFAULTS: BotSettings = {
  startMessage: "مرحباً! أهلاً وسهلاً بك 🎉",
  startMessageEntities: "",
  startButtons: "",
  subscriptionMessage: "يجب عليك الاشتراك في القنوات التالية أولاً:",
  subscriptionMessageEntities: "",
  fixedButtonsMessage: "استخدم الازرار بالاسفل لتصفح المحتوى",
  fixedButtonsMessageEntities: "",
  contentProtection: false,
};

let cache: BotSettings | null = null;
let cacheTime = 0;
const CACHE_TTL = 30_000;

export async function getSettings(): Promise<BotSettings> {
  if (cache && Date.now() - cacheTime < CACHE_TTL) return cache;
  const rows = await db.select().from(settingsTable);
  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = row.value;
  cache = {
    startMessage: map["startMessage"] ?? DEFAULTS.startMessage,
    startMessageEntities: map["startMessageEntities"] ?? DEFAULTS.startMessageEntities,
    startButtons: map["startButtons"] ?? DEFAULTS.startButtons,
    subscriptionMessage: map["subscriptionMessage"] ?? DEFAULTS.subscriptionMessage,
    subscriptionMessageEntities: map["subscriptionMessageEntities"] ?? DEFAULTS.subscriptionMessageEntities,
    fixedButtonsMessage: map["fixedButtonsMessage"] ?? DEFAULTS.fixedButtonsMessage,
    fixedButtonsMessageEntities: map["fixedButtonsMessageEntities"] ?? DEFAULTS.fixedButtonsMessageEntities,
    contentProtection: map["contentProtection"] === "true",
  };
  cacheTime = Date.now();
  return cache;
}

export async function saveSetting(key: keyof BotSettings, value: string) {
  await db.insert(settingsTable).values({ key, value }).onConflictDoUpdate({ target: settingsTable.key, set: { value } });
  invalidateCache();
}

export function invalidateCache() {
  cache = null;
  cacheTime = 0;
}
