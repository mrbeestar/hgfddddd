import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import {
  db,
  botInstancesTable,
  botChannelsTable,
  botSettingsTable,
  botUsersTable,
  buttonMessagesTable,
  commandMessagesTable,
  customCommandsTable,
  factoryChannelsTable,
  factorySettingsTable,
  fixedButtonsTable,
} from "@workspace/db";
import { and, count, eq, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { encryptBotToken } from "./token-crypto";
import { broadcastManagedBot, startManagedBot, startManagedBots, stopManagedBot } from "./managed-runtime";

const FACTORY_TOKEN = process.env["FACTORY_BOT_TOKEN"];
const OWNER_ID = process.env["OWNER_ID"] ? Number.parseInt(process.env["OWNER_ID"], 10) : 5070528919;

type FactoryState =
  | { type: "idle" }
  | { type: "wait_type" }
  | { type: "wait_token"; botType: "full" | "contact" }
  | { type: "wait_name"; botType: "full" | "contact"; token: string }
  | { type: "wait_suffix"; botType: "full" | "contact" }
  | { type: "wait_channel_id" }
  | { type: "wait_channel_name"; channelId: string }
  | { type: "wait_channel_url"; channelId: string; channelName: string }
  | { type: "wait_managed_broadcast"; botId: number }
  | { type: "wait_managed_setting"; botId: number; key: "startMessage" | "startSuffix" }
  | { type: "wait_managed_command_name"; botId: number }
  | { type: "wait_managed_command_content"; botId: number; commandId: number }
  | { type: "wait_managed_button_name"; botId: number }
  | { type: "wait_managed_button_content"; botId: number; buttonId: number };

const states = new Map<number, FactoryState>();

function getState(userId: number): FactoryState {
  return states.get(userId) ?? { type: "idle" };
}

function setState(userId: number, state: FactoryState): void {
  states.set(userId, state);
}

function resetState(userId: number): void {
  states.set(userId, { type: "idle" });
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "➕ إنشاء بوت", callback_data: "factory:add" }],
      [
        { text: "💬 التحكم في بوتات التواصل", callback_data: "factory:control:contact" },
        { text: "🔘 التحكم في بوتات الأزرار", callback_data: "factory:control:full" },
      ],
      [{ text: "📡 الاشتراك الإجباري", callback_data: "factory:channels" }],
    ],
  };
}

async function factorySetting(key: string): Promise<string> {
  const [row] = await db.select().from(factorySettingsTable).where(eq(factorySettingsTable.key, key));
  return row?.value ?? "";
}

async function saveFactorySetting(key: string, value: string): Promise<void> {
  await db.insert(factorySettingsTable).values({ key, value })
    .onConflictDoUpdate({ target: factorySettingsTable.key, set: { value } });
}

function botTypeLabel(botType: string): string {
  return botType === "full" ? "بوت أزرار" : "بوت تواصل";
}

async function showFactoryPanel(bot: TelegramBot, chatId: number, messageId?: number): Promise<void> {
  const [total] = await db.select({ count: count() }).from(botInstancesTable)
    .where(eq(botInstancesTable.ownerTelegramId, String(OWNER_ID)));
  const channels = await db.select({ count: count() }).from(factoryChannelsTable)
    .where(eq(factoryChannelsTable.isActive, true));
  const text = `🎛️ لوحة تحكم مصنع البوتات\n\n🤖 البوتات المنشأة: ${total?.count ?? 0}\n📡 قنوات الاشتراك العامة: ${channels[0]?.count ?? 0}\n\nإعدادات المصنع تُطبّق على البوتات التي يديرها المصنع.`;
  const markup = mainKeyboard();
  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: markup }).catch(() => {});
  } else {
    await bot.sendMessage(chatId, text, { reply_markup: markup });
  }
}

async function showFactoryList(bot: TelegramBot, chatId: number, messageId?: number): Promise<void> {
  const records = await db.select().from(botInstancesTable)
    .where(eq(botInstancesTable.ownerTelegramId, String(OWNER_ID)));
  const rows = [...mainKeyboard().inline_keyboard];
  let text = `🤖 مصنع البوتات (${records.length})\n\n`;

  for (const record of records) {
    text += `• ${record.name} — ${record.username ? `@${record.username}` : "غير معروف"} — ${botTypeLabel(record.botType)}\n`;
    rows.push([
      { text: "⚙️ إدارة اللوحة", callback_data: `factory:manage:${record.id}` },
    ]);
    rows.push([
      { text: record.isActive ? "⏸️ إيقاف" : "▶️ تشغيل", callback_data: `factory:toggle:${record.id}` },
      { text: "🗑️ حذف", callback_data: `factory:delete:${record.id}` },
    ]);
  }
  if (records.length === 0) text += "لا توجد بوتات منشأة بعد.";
  rows.push([{ text: "🔄 تحديث", callback_data: "factory:list" }, { text: "↩️ اللوحة", callback_data: "factory:panel" }]);

  const options = {
    chat_id: chatId,
    ...(messageId ? { message_id: messageId } : {}),
    reply_markup: { inline_keyboard: rows },
  };
  if (messageId) {
    await bot.editMessageText(text, options).catch(() => {});
  } else {
    await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
  }
}

async function showTypeControl(bot: TelegramBot, chatId: number, messageId: number, botType: "full" | "contact"): Promise<void> {
  const records = await db.select().from(botInstancesTable).where(and(
    eq(botInstancesTable.ownerTelegramId, String(OWNER_ID)),
    eq(botInstancesTable.botType, botType),
  ));
  const suffix = await factorySetting(`${botType}StartSuffix`);
  const text = `🛠️ ${botTypeLabel(botType)}\n\nالنص الثابت الحالي:\n${suffix || "غير معيّن"}\n\nسيُضاف هذا النص كنص عادي في نهاية رسالة /start، وليس كزر.`;
  const rows = [
    [{ text: "📝 تعيين النص الثابت", callback_data: `factory:suffix:${botType}` }],
    ...records.map(record => [
      { text: `⚙️ ${record.name}`, callback_data: `factory:manage:${record.id}` },
    ]),
    ...records.flatMap(record => [[
      { text: record.isActive ? "⏸️ إيقاف" : "▶️ تشغيل", callback_data: `factory:toggle:${record.id}` },
      { text: "🗑️ حذف", callback_data: `factory:delete:${record.id}` },
    ]]),
    [{ text: "↩️ لوحة المصنع", callback_data: "factory:panel" }],
  ];
  await bot.editMessageText(`${text}\n\nالبوتات: ${records.length}`, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: rows },
  }).catch(() => {});
}

async function ownedBot(botId: number): Promise<typeof botInstancesTable.$inferSelect | undefined> {
  const [record] = await db.select().from(botInstancesTable).where(and(
    eq(botInstancesTable.id, botId),
    eq(botInstancesTable.ownerTelegramId, String(OWNER_ID)),
  ));
  return record;
}

async function showManagedPanel(bot: TelegramBot, chatId: number, messageId: number, botId: number): Promise<void> {
  const record = await ownedBot(botId);
  if (!record) return;
  const [users] = await db.select({ count: count() }).from(botUsersTable).where(eq(botUsersTable.botId, botId));
  const [commands] = await db.select({ count: count() }).from(customCommandsTable).where(eq(customCommandsTable.botId, botId));
  const [buttons] = await db.select({ count: count() }).from(fixedButtonsTable).where(eq(fixedButtonsTable.botId, botId));
  const startMessage = await botSettingForFactory(botId, "startMessage");
  const suffix = await botSettingForFactory(botId, "startSuffix");
  const rows = [
    [
      { text: "📊 الإحصائيات", callback_data: `factory:stats:${botId}` },
      { text: "📢 إذاعة", callback_data: `factory:broadcast:${botId}` },
    ],
    [
      { text: "👥 المستخدمون", callback_data: `factory:users:${botId}` },
      { text: "⌨️ الأوامر", callback_data: `factory:commands:${botId}` },
    ],
    [{ text: "⚙️ الإعدادات", callback_data: `factory:settings:${botId}` }],
    ...(record.botType === "full" ? [[{ text: `🔘 الأزرار (${buttons?.count ?? 0})`, callback_data: `factory:buttons:${botId}` }]] : []),
    [{ text: "↩️ رجوع", callback_data: `factory:control:${record.botType}` }],
  ];
  await bot.editMessageText(
    `🎛️ لوحة تحكم ${record.name}\nالنوع: ${botTypeLabel(record.botType)}\n\n` +
    `👥 المستخدمون: ${users?.count ?? 0}\n⌨️ الأوامر: ${commands?.count ?? 0}\n` +
    (record.botType === "full" ? `🔘 الأزرار: ${buttons?.count ?? 0}\n` : "") +
    `\n📨 رسالة البداية: ${startMessage.slice(0, 60)}\n📝 النص الختامي: ${suffix || "غير معيّن"}`,
    { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } },
  ).catch(() => {});
}

async function botSettingForFactory(botId: number, key: string): Promise<string> {
  const [row] = await db.select().from(botSettingsTable).where(and(
    eq(botSettingsTable.botId, botId),
    eq(botSettingsTable.key, key),
  ));
  return row?.value ?? "";
}

async function showManagedStats(bot: TelegramBot, chatId: number, messageId: number, botId: number): Promise<void> {
  const record = await ownedBot(botId);
  if (!record) return;
  const [users] = await db.select({ count: count() }).from(botUsersTable).where(eq(botUsersTable.botId, botId));
  const [blocked] = await db.select({ count: count() }).from(botUsersTable).where(and(eq(botUsersTable.botId, botId), eq(botUsersTable.isBlockedBot, true)));
  await bot.editMessageText(`📊 إحصائيات ${record.name}\n\nالمستخدمون: ${users?.count ?? 0}\nالمستخدمون الذين حظروا البوت: ${blocked?.count ?? 0}`, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [[{ text: "↩️ لوحة البوت", callback_data: `factory:manage:${botId}` }]] },
  }).catch(() => {});
}

async function showManagedUsers(bot: TelegramBot, chatId: number, messageId: number, botId: number): Promise<void> {
  const record = await ownedBot(botId);
  if (!record) return;
  const users = await db.select().from(botUsersTable).where(eq(botUsersTable.botId, botId)).limit(20);
  const rows = users.map(user => [{
    text: `${user.isBanned ? "🚫" : "👤"} ${user.firstName || user.username || user.telegramId}`,
    callback_data: `factory:user:toggle:${botId}:${user.id}`,
  }]);
  const text = users.length
    ? `👥 مستخدمو ${record.name}\n\nاضغط على مستخدم لتغيير حالة الحظر:\n${users.map(user => `${user.isBanned ? "🚫" : "✅"} ${user.firstName || user.username || user.telegramId}`).join("\n")}`
    : "👥 لا يوجد مستخدمون لهذا البوت بعد.";
  rows.push([{ text: "↩️ لوحة البوت", callback_data: `factory:manage:${botId}` }]);
  await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } }).catch(() => {});
}

async function showManagedCommands(bot: TelegramBot, chatId: number, messageId: number, botId: number): Promise<void> {
  const commands = await db.select().from(customCommandsTable).where(eq(customCommandsTable.botId, botId));
  const rows = [
    [{ text: "➕ إضافة أمر", callback_data: `factory:command:add:${botId}` }],
    ...commands.map(command => [{ text: `${command.isActive ? "✅" : "❌"} /${command.command}`, callback_data: `factory:command:toggle:${botId}:${command.id}` }]),
    [{ text: "↩️ لوحة البوت", callback_data: `factory:manage:${botId}` }],
  ];
  await bot.editMessageText(`⌨️ أوامر البوت (${commands.length})`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } }).catch(() => {});
}

async function showManagedSettings(bot: TelegramBot, chatId: number, messageId: number, botId: number): Promise<void> {
  const start = await botSettingForFactory(botId, "startMessage");
  const suffix = await botSettingForFactory(botId, "startSuffix");
  await bot.editMessageText(`⚙️ إعدادات البوت\n\n📨 رسالة البداية:\n${start || "مرحباً بك!"}\n\n📝 النص الختامي:\n${suffix || "غير معيّن"}`, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [
      [{ text: "📨 تعديل رسالة البداية", callback_data: `factory:settings:start:${botId}` }],
      [{ text: "📝 تعديل النص الختامي", callback_data: `factory:settings:suffix:${botId}` }],
      [{ text: "↩️ لوحة البوت", callback_data: `factory:manage:${botId}` }],
    ] },
  }).catch(() => {});
}

async function showManagedButtons(bot: TelegramBot, chatId: number, messageId: number, botId: number): Promise<void> {
  const buttons = await db.select().from(fixedButtonsTable).where(and(eq(fixedButtonsTable.botId, botId), isNull(fixedButtonsTable.parentId)));
  const rows = [
    [{ text: "➕ إضافة زر", callback_data: `factory:button:add:${botId}` }],
    ...buttons.map(button => [{ text: `${button.isActive ? "✅" : "❌"} ${button.label}`, callback_data: `factory:button:toggle:${botId}:${button.id}` }]),
    [{ text: "↩️ لوحة البوت", callback_data: `factory:manage:${botId}` }],
  ];
  await bot.editMessageText(`🔘 الأزرار الثابتة (${buttons.length})`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } }).catch(() => {});
}

async function showFactoryChannels(bot: TelegramBot, chatId: number, messageId: number): Promise<void> {
  const channels = await db.select().from(factoryChannelsTable);
  let text = `📡 الاشتراك الإجباري العام (${channels.length})\n\n`;
  const rows: Array<Array<{ text: string; callback_data: string }>> = [
    [{ text: "➕ إضافة قناة أو مجموعة", callback_data: "factory:channel:add" }],
  ];
  for (const channel of channels) {
    text += `• ${channel.channelName} (${channel.channelId}) ${channel.isActive ? "✅" : "❌"}\n`;
    rows.push([
      { text: channel.isActive ? "❌ تعطيل" : "✅ تفعيل", callback_data: `factory:channel:toggle:${channel.id}` },
      { text: "🗑️ حذف", callback_data: `factory:channel:delete:${channel.id}` },
    ]);
  }
  if (channels.length === 0) text += "لا توجد قنوات أو مجموعات.";
  rows.push([{ text: "↩️ لوحة المصنع", callback_data: "factory:panel" }]);
  await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } }).catch(() => {});
}

async function copyFactoryChannels(botId: number): Promise<void> {
  const channels = await db.select().from(factoryChannelsTable).where(eq(factoryChannelsTable.isActive, true));
  for (const channel of channels) {
    await db.insert(botChannelsTable).values({
      botId,
      channelId: channel.channelId,
      channelName: channel.channelName,
      channelUsername: channel.channelUsername,
      channelUrl: channel.channelUrl,
      isActive: true,
    }).onConflictDoNothing();
  }
}

async function copyFactoryStartSettings(botId: number, botType: "full" | "contact"): Promise<void> {
  const suffix = await factorySetting(`${botType}StartSuffix`);
  if (suffix) {
    await db.insert(botSettingsTable).values({ botId, key: "startSuffix", value: suffix });
  }
}

async function handleCallback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  const userId = query.from.id;
  if (userId !== OWNER_ID) {
    await bot.answerCallbackQuery(query.id, { text: "غير مسموح." }).catch(() => {});
    return;
  }

  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) return;

  await bot.answerCallbackQuery(query.id).catch(() => {});
  const data = query.data ?? "";

  if (data === "factory:list") {
    resetState(userId);
    await showFactoryList(bot, chatId, messageId);
    return;
  }
  if (data === "factory:panel") {
    resetState(userId);
    await showFactoryPanel(bot, chatId, messageId);
    return;
  }

  if (data === "factory:add") {
    setState(userId, { type: "wait_type" });
    await bot.editMessageText("🤖 اختر نوع البوت الذي تريد إنشاءه:", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔘 بوت أزرار", callback_data: "factory:type:full" }],
          [{ text: "💬 بوت تواصل", callback_data: "factory:type:contact" }],
          [{ text: "↩️ رجوع", callback_data: "factory:list" }],
        ],
      },
    });
    return;
  }

  if (data.startsWith("factory:type:")) {
    const botType = data.endsWith(":contact") ? "contact" : "full";
    setState(userId, { type: "wait_token", botType });
    await bot.editMessageText(
      `🔐 أرسل توكن البوت من BotFather.\n\nالنوع المختار: ${botTypeLabel(botType)}\nلن يتم عرض التوكن أو تخزينه بصيغته المكشوفة.`,
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: "factory:list" }]] },
      },
    );
    return;
  }

  if (data.startsWith("factory:toggle:")) {
    const botId = Number.parseInt(data.slice("factory:toggle:".length), 10);
    const [record] = await db.select().from(botInstancesTable)
      .where(and(eq(botInstancesTable.id, botId), eq(botInstancesTable.ownerTelegramId, String(OWNER_ID))));
    if (record) {
      if (record.isActive) {
        await stopManagedBot(botId);
      } else {
        await startManagedBot(record);
      }
      await db.update(botInstancesTable).set({ isActive: !record.isActive }).where(eq(botInstancesTable.id, botId));
    }
    await showFactoryList(bot, chatId, messageId);
    return;
  }

  if (data.startsWith("factory:delete:")) {
    const botId = Number.parseInt(data.slice("factory:delete:".length), 10);
    const [record] = await db.select().from(botInstancesTable)
      .where(and(eq(botInstancesTable.id, botId), eq(botInstancesTable.ownerTelegramId, String(OWNER_ID))));
    if (record) {
      await stopManagedBot(botId);
      await db.delete(botInstancesTable).where(eq(botInstancesTable.id, botId));
    }
    await showFactoryList(bot, chatId, messageId);
    return;
  }

  if (data.startsWith("factory:manage:")) {
    await showManagedPanel(bot, chatId, messageId, Number(data.split(":")[2]));
    return;
  }
  if (data.startsWith("factory:stats:")) {
    await showManagedStats(bot, chatId, messageId, Number(data.split(":")[2]));
    return;
  }
  if (data.startsWith("factory:users:")) {
    await showManagedUsers(bot, chatId, messageId, Number(data.split(":")[2]));
    return;
  }
  if (data.startsWith("factory:commands:")) {
    await showManagedCommands(bot, chatId, messageId, Number(data.split(":")[2]));
    return;
  }
  if (data.startsWith("factory:buttons:")) {
    const record = await ownedBot(Number(data.split(":")[2]));
    if (record?.botType === "full") await showManagedButtons(bot, chatId, messageId, record.id);
    return;
  }
  if (data.startsWith("factory:settings:") && !data.startsWith("factory:settings:start:") && !data.startsWith("factory:settings:suffix:")) {
    await showManagedSettings(bot, chatId, messageId, Number(data.split(":")[2]));
    return;
  }
  if (data.startsWith("factory:broadcast:")) {
    const botId = Number(data.split(":")[2]);
    if (await ownedBot(botId)) {
      setState(userId, { type: "wait_managed_broadcast", botId });
      await bot.editMessageText("📢 أرسل نص الإذاعة الآن:", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: `factory:manage:${botId}` }]] },
      });
    }
    return;
  }
  if (data.startsWith("factory:settings:start:") || data.startsWith("factory:settings:suffix:")) {
    const parts = data.split(":");
    const key = data.startsWith("factory:settings:start:") ? "startMessage" : "startSuffix";
    const botId = Number(parts[3]);
    if (await ownedBot(botId)) {
      setState(userId, { type: "wait_managed_setting", botId, key });
      await bot.editMessageText(
        key === "startMessage" ? "📨 أرسل رسالة البداية الجديدة للبوت:" : "📝 أرسل النص الذي سيظهر في نهاية /start:",
        { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: `factory:settings:${botId}` }]] } },
      );
    }
    return;
  }
  if (data.startsWith("factory:user:toggle:")) {
    const parts = data.split(":");
    const botId = Number(parts[3]);
    const userIdToToggle = Number(parts[4]);
    if (await ownedBot(botId)) {
      const [user] = await db.select().from(botUsersTable).where(and(eq(botUsersTable.id, userIdToToggle), eq(botUsersTable.botId, botId)));
      if (user) await db.update(botUsersTable).set({ isBanned: !user.isBanned }).where(eq(botUsersTable.id, userIdToToggle));
      await showManagedUsers(bot, chatId, messageId, botId);
    }
    return;
  }
  if (data.startsWith("factory:command:add:")) {
    const botId = Number(data.split(":")[3]);
    if (await ownedBot(botId)) {
      setState(userId, { type: "wait_managed_command_name", botId });
      await bot.editMessageText("⌨️ أرسل اسم الأمر بدون /، مثل: help", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: `factory:commands:${botId}` }]] },
      });
    }
    return;
  }
  if (data.startsWith("factory:command:toggle:")) {
    const parts = data.split(":");
    const botId = Number(parts[3]);
    const commandId = Number(parts[4]);
    if (await ownedBot(botId)) {
      const [command] = await db.select().from(customCommandsTable).where(and(eq(customCommandsTable.id, commandId), eq(customCommandsTable.botId, botId)));
      if (command) await db.update(customCommandsTable).set({ isActive: !command.isActive }).where(eq(customCommandsTable.id, commandId));
      await showManagedCommands(bot, chatId, messageId, botId);
    }
    return;
  }
  if (data.startsWith("factory:button:add:")) {
    const botId = Number(data.split(":")[3]);
    if ((await ownedBot(botId))?.botType === "full") {
      setState(userId, { type: "wait_managed_button_name", botId });
      await bot.editMessageText("🔘 أرسل اسم الزر الجديد:", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: `factory:buttons:${botId}` }]] },
      });
    }
    return;
  }
  if (data.startsWith("factory:button:toggle:")) {
    const parts = data.split(":");
    const botId = Number(parts[3]);
    const buttonId = Number(parts[4]);
    if (await ownedBot(botId)) {
      const [button] = await db.select().from(fixedButtonsTable).where(and(eq(fixedButtonsTable.id, buttonId), eq(fixedButtonsTable.botId, botId)));
      if (button) await db.update(fixedButtonsTable).set({ isActive: !button.isActive }).where(eq(fixedButtonsTable.id, buttonId));
      await showManagedButtons(bot, chatId, messageId, botId);
    }
    return;
  }

  if (data.startsWith("factory:control:")) {
    const botType = data.endsWith(":contact") ? "contact" : "full";
    await showTypeControl(bot, chatId, messageId, botType);
    return;
  }

  if (data.startsWith("factory:suffix:")) {
    const botType = data.endsWith(":contact") ? "contact" : "full";
    setState(userId, { type: "wait_suffix", botType });
    await bot.editMessageText(
      `📝 أرسل النص الثابت الذي سيظهر في نهاية رسالة /start لكل ${botTypeLabel(botType)} جديد.\n\nسيُضاف كنص عادي وليس كزر شفاف.`,
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: `factory:control:${botType}` }]] },
      },
    );
    return;
  }

  if (data === "factory:channels") {
    await showFactoryChannels(bot, chatId, messageId);
    return;
  }

  if (data === "factory:channel:add") {
    setState(userId, { type: "wait_channel_id" });
    await bot.editMessageText("📡 أرسل معرف القناة أو المجموعة، مثل @channel أو -1001234567890:", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: "factory:channels" }]] },
    });
    return;
  }

  if (data.startsWith("factory:channel:toggle:")) {
    const channelId = Number.parseInt(data.slice("factory:channel:toggle:".length), 10);
    const [channel] = await db.select().from(factoryChannelsTable).where(eq(factoryChannelsTable.id, channelId));
    if (channel) await db.update(factoryChannelsTable).set({ isActive: !channel.isActive }).where(eq(factoryChannelsTable.id, channelId));
    await showFactoryChannels(bot, chatId, messageId);
    return;
  }

  if (data.startsWith("factory:channel:delete:")) {
    const channelId = Number.parseInt(data.slice("factory:channel:delete:".length), 10);
    await db.delete(factoryChannelsTable).where(eq(factoryChannelsTable.id, channelId));
    await showFactoryChannels(bot, chatId, messageId);
  }
}

async function handleText(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  if (userId !== OWNER_ID) return;

  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? "";
  const state = getState(userId);

  if (state.type === "wait_type") {
    await bot.sendMessage(chatId, "❌ اختر نوع البوت من الأزرار.");
    return;
  }

  if (state.type === "wait_token") {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(text)) {
      await bot.sendMessage(chatId, "❌ صيغة التوكن غير صحيحة. أرسله كما هو من BotFather.");
      return;
    }
    try {
      const candidate = new TelegramBot(text, { polling: false });
      const me = await candidate.getMe();
      const duplicate = await db.select({ id: botInstancesTable.id }).from(botInstancesTable)
        .where(eq(botInstancesTable.username, me.username ?? ""));
      if (duplicate.length > 0) {
        await bot.sendMessage(chatId, "❌ هذا البوت مضاف مسبقاً.");
        return;
      }
      setState(userId, { type: "wait_name", botType: state.botType, token: text });
      await bot.sendMessage(chatId, `✅ تم التحقق من @${me.username ?? "البوت"}.\nأرسل اسماً داخلياً للبوت:`);
    } catch {
      await bot.sendMessage(chatId, "❌ تعذر التحقق من التوكن. تأكد من أنه صحيح وأن البوت لم يتم حذفه.");
    }
    return;
  }

  if (state.type === "wait_name") {
    const name = text.slice(0, 80);
    if (!name) {
      await bot.sendMessage(chatId, "❌ أرسل اسماً صالحاً.");
      return;
    }
    try {
      const encrypted = encryptBotToken(state.token);
      const [record] = await db.insert(botInstancesTable).values({
        ownerTelegramId: String(OWNER_ID),
        name,
        botType: state.botType,
        tokenEncrypted: encrypted,
        isActive: true,
      }).returning();
      await copyFactoryStartSettings(record!.id, state.botType);
      await copyFactoryChannels(record!.id);
      await startManagedBot(record!);
      resetState(userId);
      await bot.sendMessage(chatId, `✅ تم إنشاء وتشغيل "${name}".\nالنوع: ${botTypeLabel(state.botType)}`, {
        reply_markup: { inline_keyboard: [[{ text: "🤖 مصنع البوتات", callback_data: "factory:list" }]] },
      });
    } catch (err) {
      logger.error({ err }, "Factory bot creation failed");
      await bot.sendMessage(chatId, "❌ تعذر إنشاء البوت أو تشغيله. راجع التوكن وحاول مرة أخرى.");
    }
    return;
  }

  if (state.type === "wait_suffix") {
    await saveFactorySetting(`${state.botType}StartSuffix`, text);
    resetState(userId);
    await bot.sendMessage(chatId, `✅ تم حفظ النص الثابت لـ${botTypeLabel(state.botType)}.`, {
      reply_markup: { inline_keyboard: [[{ text: "↩️ التحكم", callback_data: `factory:control:${state.botType}` }]] },
    });
    return;
  }

  if (state.type === "wait_managed_broadcast") {
    const result = await broadcastManagedBot(state.botId, text);
    resetState(userId);
    await bot.sendMessage(chatId, result.available ? `✅ تم إرسال الإذاعة إلى ${result.sent} مستخدم.` : "❌ البوت متوقف حالياً، شغّله أولاً.");
    return;
  }

  if (state.type === "wait_managed_setting") {
    await db.insert(botSettingsTable).values({ botId: state.botId, key: state.key, value: text })
      .onConflictDoUpdate({ target: [botSettingsTable.botId, botSettingsTable.key], set: { value: text } });
    resetState(userId);
    await bot.sendMessage(chatId, "✅ تم حفظ الإعداد.", {
      reply_markup: { inline_keyboard: [[{ text: "⚙️ إعدادات البوت", callback_data: `factory:settings:${state.botId}` }]] },
    });
    return;
  }

  if (state.type === "wait_managed_command_name") {
    const command = text.replace(/^\/+/, "").toLowerCase();
    if (!/^[a-z0-9_]{1,32}$/.test(command)) {
      await bot.sendMessage(chatId, "❌ اسم الأمر غير صالح. استخدم أحرفاً إنجليزية وأرقاماً وشرطة سفلية.");
      return;
    }
    const [created] = await db.insert(customCommandsTable).values({
      botId: state.botId,
      command,
      title: `/${command}`,
      isActive: true,
    }).returning();
    resetState(userId);
    await bot.sendMessage(chatId, `✅ تم إنشاء /${command}. أضف ردوده من لوحة البوت المنشأ.`, {
      reply_markup: { inline_keyboard: [[{ text: "⌨️ الأوامر", callback_data: `factory:commands:${state.botId}` }]] },
    });
    void created;
    return;
  }

  if (state.type === "wait_managed_button_name") {
    if (!text) {
      await bot.sendMessage(chatId, "❌ أرسل اسماً صالحاً للزر.");
      return;
    }
    const [created] = await db.insert(fixedButtonsTable).values({
      botId: state.botId,
      label: text.slice(0, 64),
      token: `${state.botId}-${Date.now()}`,
      rowGroup: 0,
      orderIndex: 0,
      isActive: true,
    }).returning();
    resetState(userId);
    await bot.sendMessage(chatId, "✅ تم إنشاء الزر. أضف رسائله من لوحة البوت المنشأ.", {
      reply_markup: { inline_keyboard: [[{ text: "🔘 الأزرار", callback_data: `factory:buttons:${state.botId}` }]] },
    });
    void created;
    return;
  }

  if (state.type === "wait_channel_id") {
    if (!text) {
      await bot.sendMessage(chatId, "❌ أرسل معرف القناة أو المجموعة.");
      return;
    }
    setState(userId, { type: "wait_channel_name", channelId: text });
    await bot.sendMessage(chatId, "أرسل اسماً واضحاً للقناة أو المجموعة:");
    return;
  }

  if (state.type === "wait_channel_name") {
    if (!text) {
      await bot.sendMessage(chatId, "❌ أرسل اسماً صالحاً.");
      return;
    }
    setState(userId, { type: "wait_channel_url", channelId: state.channelId, channelName: text });
    await bot.sendMessage(chatId, "أرسل رابط القناة أو المجموعة، أو أرسل «لا» إذا لم يوجد:");
    return;
  }

  if (state.type === "wait_channel_url") {
    const channelUrl = text === "لا" ? null : (text.startsWith("http") ? text : `https://t.me/${text.replace(/^@/, "")}`);
    try {
      await db.insert(factoryChannelsTable).values({
        channelId: state.channelId,
        channelName: state.channelName,
        channelUsername: state.channelId.startsWith("@") ? state.channelId.slice(1) : null,
        channelUrl,
        isActive: true,
      });
      resetState(userId);
      await bot.sendMessage(chatId, "✅ تمت إضافة القناة/المجموعة، وستُنسخ إلى البوتات الجديدة.", {
        reply_markup: { inline_keyboard: [[{ text: "📡 الاشتراك الإجباري", callback_data: "factory:channels" }]] },
      });
    } catch {
      await bot.sendMessage(chatId, "❌ هذه القناة أو المجموعة مضافة مسبقاً.");
    }
  }
}

export async function startFactoryBot(): Promise<void> {
  if (!FACTORY_TOKEN) {
    logger.warn("FACTORY_BOT_TOKEN not set, factory bot will not start");
    return;
  }

  const bot = new TelegramBot(FACTORY_TOKEN, { polling: true });
  const me = await bot.getMe();
  bot.on("polling_error", err => logger.error({ err }, "Factory bot polling error"));
  bot.onText(/^\/(?:start|panel)(?:@[A-Za-z0-9_]+)?$/, msg => {
    if (msg.from?.id === OWNER_ID) void showFactoryPanel(bot, msg.chat.id);
  });
  bot.on("callback_query", query => {
    void handleCallback(bot, query).catch(err => logger.error({ err }, "Factory bot callback error"));
  });
  bot.on("message", msg => {
    if (msg.text?.startsWith("/")) return;
    void handleText(bot, msg).catch(err => logger.error({ err }, "Factory bot message error"));
  });
  await startManagedBots();
  logger.info({ botUsername: me.username }, "Factory bot started successfully");
}