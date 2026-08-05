import TelegramBot from "node-telegram-bot-api";
import type { Message, InlineKeyboardButton, KeyboardButton, CallbackQuery } from "node-telegram-bot-api";
import {
  db,
  botInstancesTable,
  botUsersTable,
  botSettingsTable,
  botChannelsTable,
  customCommandsTable,
  commandMessagesTable,
  fixedButtonsTable,
  buttonMessagesTable,
} from "@workspace/db";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { sendBotMessage } from "./send";
import { decryptBotToken } from "./token-crypto";

type ManagedBot = {
  record: typeof botInstancesTable.$inferSelect;
  bot: TelegramBot;
  username: string;
};

type ManagedState =
  | { type: "idle" }
  | { type: "command_name" }
  | { type: "command_content"; commandId: number }
  | { type: "command_inline"; commandId: number; messageType: string; content: string; caption?: string; contentEntities?: string; captionEntities?: string; forwardData?: string }
  | { type: "button_name" }
  | { type: "button_content"; buttonId: number }
  | { type: "broadcast_content" }
  | { type: "settings_value"; key: string };

const runtimes = new Map<number, ManagedBot>();
const states = new Map<string, ManagedState>();
const navStack = new Map<string, number[]>();
const replyKeyboardState = new Map<string, number[]>();

const DEFAULT_SETTINGS: Record<string, string> = {
  startMessage: "مرحباً بك!",
  subscriptionMessage: "يجب عليك الاشتراك في القنوات التالية أولاً:",
  contentProtection: "false",
};

const NAV_BACK = "🔙 رجوع";
const NAV_HOME = "🏠 الرئيسية";
const NAV_NEXT = "التالي ▶️";
const NAV_PREV = "◀️ السابق";

type ManagedContent = {
  messageType: string;
  content: string;
  caption?: string;
  contentEntities?: string;
  captionEntities?: string;
  forwardData?: string;
};

function jsonValue(value: unknown): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value);
}

function detectManagedContent(msg: Message): ManagedContent | undefined {
  if (msg.text) {
    return { messageType: "text", content: msg.text, contentEntities: jsonValue(msg.entities) };
  }
  if (msg.photo?.length) {
    return {
      messageType: "photo",
      content: msg.photo[msg.photo.length - 1]!.file_id,
      caption: msg.caption,
      captionEntities: jsonValue(msg.caption_entities),
    };
  }
  if (msg.video) return { messageType: "video", content: msg.video.file_id, caption: msg.caption, captionEntities: jsonValue(msg.caption_entities) };
  if (msg.audio) return { messageType: "audio", content: msg.audio.file_id, caption: msg.caption, captionEntities: jsonValue(msg.caption_entities) };
  if (msg.document) return { messageType: "document", content: msg.document.file_id, caption: msg.caption, captionEntities: jsonValue(msg.caption_entities) };
  if (msg.animation) return { messageType: "animation", content: msg.animation.file_id, caption: msg.caption, captionEntities: jsonValue(msg.caption_entities) };
  if (msg.voice) return { messageType: "voice", content: msg.voice.file_id, caption: msg.caption, captionEntities: jsonValue(msg.caption_entities) };
  if (msg.video_note) return { messageType: "video_note", content: msg.video_note.file_id };
  if (msg.sticker) return { messageType: "sticker", content: msg.sticker.file_id };
  if (msg.location) return { messageType: "location", content: JSON.stringify(msg.location) };
  if (msg.venue) return { messageType: "venue", content: JSON.stringify(msg.venue) };
  if (msg.contact) return { messageType: "contact", content: JSON.stringify(msg.contact) };
  if (msg.poll) {
    return {
      messageType: "poll",
      content: JSON.stringify({
        question: msg.poll.question,
        options: msg.poll.options.map(option => option.text),
        is_anonymous: msg.poll.is_anonymous,
        type: msg.poll.type,
        allows_multiple_answers: msg.poll.allows_multiple_answers,
      }),
    };
  }
  if (msg.dice) return { messageType: "dice", content: JSON.stringify({ emoji: msg.dice.emoji }) };
  return undefined;
}

function stateKey(botId: number, userId: number): string {
  return `${botId}:${userId}`;
}

function commandStackKey(botId: number, userId: number): string {
  return `${botId}:${userId}`;
}

function adminId(runtime: ManagedBot): number {
  return Number(runtime.record.ownerTelegramId);
}

async function setting(botId: number, key: string): Promise<string> {
  const [row] = await db.select().from(botSettingsTable).where(and(eq(botSettingsTable.botId, botId), eq(botSettingsTable.key, key)));
  return row?.value ?? DEFAULT_SETTINGS[key] ?? "";
}

async function botChannels(botId: number): Promise<typeof botChannelsTable.$inferSelect[]> {
  return db.select().from(botChannelsTable).where(and(
    eq(botChannelsTable.botId, botId),
    eq(botChannelsTable.isActive, true),
  ));
}

function subscriptionMarkup(channels: typeof botChannelsTable.$inferSelect[]): { inline_keyboard: InlineKeyboardButton[][] } {
  const rows: InlineKeyboardButton[][] = channels.map(channel => [{
    text: `📡 اشترك في ${channel.channelName}`,
    url: channel.channelUrl || (channel.channelUsername ? `https://t.me/${channel.channelUsername}` : channel.channelId),
  }]);
  rows.push([{ text: "✅ تحققت من الاشتراك", callback_data: "m:check_subscription" }]);
  return { inline_keyboard: rows };
}

async function missingSubscriptions(runtime: ManagedBot, chatId: number): Promise<typeof botChannelsTable.$inferSelect[]> {
  const channels = await botChannels(runtime.record.id);
  const missing: typeof channels = [];
  for (const channel of channels) {
    try {
      const member = await runtime.bot.getChatMember(channel.channelId, chatId);
      if (!["member", "administrator", "creator"].includes(member.status)) missing.push(channel);
    } catch {
      missing.push(channel);
    }
  }
  return missing;
}

async function sendSubscriptionPrompt(runtime: ManagedBot, chatId: number): Promise<void> {
  const channels = await missingSubscriptions(runtime, chatId);
  if (channels.length === 0) return;
  const message = await setting(runtime.record.id, "subscriptionMessage");
  await runtime.bot.sendMessage(chatId, message || DEFAULT_SETTINGS.subscriptionMessage, {
    reply_markup: subscriptionMarkup(channels),
  });
}

async function saveSetting(botId: number, key: string, value: string): Promise<void> {
  await db.insert(botSettingsTable).values({ botId, key, value })
    .onConflictDoUpdate({ target: [botSettingsTable.botId, botSettingsTable.key], set: { value } });
}

async function registerUser(runtime: ManagedBot, msg: Message): Promise<typeof botUsersTable.$inferSelect | undefined> {
  if (!msg.from) return undefined;
  const values = {
    botId: runtime.record.id,
    telegramId: String(msg.from.id),
    username: msg.from.username ?? null,
    firstName: msg.from.first_name ?? null,
    lastName: msg.from.last_name ?? null,
    updatedAt: new Date(),
  };
  await db.insert(botUsersTable).values(values).onConflictDoUpdate({
    target: [botUsersTable.botId, botUsersTable.telegramId],
    set: { username: values.username, firstName: values.firstName, lastName: values.lastName, updatedAt: values.updatedAt },
  });
  const [user] = await db.select().from(botUsersTable).where(and(eq(botUsersTable.botId, runtime.record.id), eq(botUsersTable.telegramId, String(msg.from.id))));
  return user;
}

function ownerPanel(runtime: ManagedBot): { inline_keyboard: InlineKeyboardButton[][] } {
  const rows: InlineKeyboardButton[][] = [
    [{ text: "📊 إحصائيات", callback_data: "m:stats" }, { text: "📢 إذاعة", callback_data: "m:broadcast" }],
    [{ text: "⌨️ الأوامر", callback_data: "m:commands" }, { text: "⚙️ الإعدادات", callback_data: "m:settings" }],
  ];
  if (runtime.record.botType === "full") rows.splice(1, 0, [{ text: "🔘 الأزرار الثابتة", callback_data: "m:buttons" }]);
  return { inline_keyboard: rows };
}

async function sendPanel(runtime: ManagedBot, chatId: number, messageId?: number): Promise<void> {
  const text = `🎛️ لوحة تحكم ${runtime.record.name}\nنوع البوت: ${runtime.record.botType === "full" ? "أزرار" : "تواصل"}`;
  if (messageId) {
    await runtime.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: ownerPanel(runtime) }).catch(() => {});
  } else {
    await runtime.bot.sendMessage(chatId, text, { reply_markup: ownerPanel(runtime) });
  }
}

async function sendCommand(runtime: ManagedBot, chatId: number, userId: number, commandId: number): Promise<void> {
  const messages = await db.select().from(commandMessagesTable).where(eq(commandMessagesTable.commandId, commandId)).orderBy(asc(commandMessagesTable.orderIndex));
  const protect = (await setting(runtime.record.id, "contentProtection")) === "true";
  for (const message of messages) {
    await sendBotMessage(chatId, message.messageType, message.content, message.caption ?? undefined, message.inlineButtons ?? undefined, protect, {
      contentEntities: message.contentEntities,
      captionEntities: message.captionEntities,
      forwardData: message.forwardData,
      interactiveCommandId: commandId,
      botOverride: runtime.bot,
    });
  }
  void userId;
}

async function rootButtons(runtime: ManagedBot): Promise<typeof fixedButtonsTable.$inferSelect[]> {
  return db.select().from(fixedButtonsTable)
    .where(and(eq(fixedButtonsTable.botId, runtime.record.id), eq(fixedButtonsTable.isActive, true), isNull(fixedButtonsTable.parentId)))
    .orderBy(asc(fixedButtonsTable.rowGroup), asc(fixedButtonsTable.orderIndex));
}

async function showButtons(runtime: ManagedBot, chatId: number, userId: number, parentId: number | null, page = 0): Promise<void> {
  const buttons = await db.select().from(fixedButtonsTable).where(and(
    eq(fixedButtonsTable.botId, runtime.record.id),
    eq(fixedButtonsTable.isActive, true),
    parentId === null ? isNull(fixedButtonsTable.parentId) : eq(fixedButtonsTable.parentId, parentId),
  )).orderBy(asc(fixedButtonsTable.rowGroup), asc(fixedButtonsTable.orderIndex));
  const groups = new Map<number, KeyboardButton[]>();
  for (const button of buttons.slice(page * 20, page * 20 + 20)) {
    const group = groups.get(button.rowGroup) ?? [];
    group.push({ text: button.label });
    groups.set(button.rowGroup, group);
  }
  const keyboard = [...groups.values()];
  const pageCount = Math.ceil(buttons.length / 20);
  if (page > 0 || page < pageCount - 1) keyboard.push([
    ...(page > 0 ? [{ text: NAV_PREV }] : []),
    ...(page < pageCount - 1 ? [{ text: NAV_NEXT }] : []),
  ]);
  if (parentId !== null) keyboard.push([{ text: NAV_BACK }, { text: NAV_HOME }]);
  replyKeyboardState.set(stateKey(runtime.record.id, userId), parentId === null ? [] : [parentId]);
  await runtime.bot.sendMessage(chatId, parentId === null ? "اختر من القائمة:" : "اختر من القائمة:", { reply_markup: { keyboard, resize_keyboard: true } });
}

async function sendStart(runtime: ManagedBot, msg: Message, user: typeof botUsersTable.$inferSelect | undefined): Promise<void> {
  const chatId = msg.chat.id;
  if (user?.isBanned) return;
  if (Number(msg.from?.id) === adminId(runtime)) await sendPanel(runtime, chatId);
  if (Number(msg.from?.id) !== adminId(runtime)) {
    const missing = await missingSubscriptions(runtime, chatId);
    if (missing.length > 0) {
      await sendSubscriptionPrompt(runtime, chatId);
      return;
    }
  }
  const text = (await setting(runtime.record.id, "startMessage")) || DEFAULT_SETTINGS.startMessage;
  const suffix = await setting(runtime.record.id, "startSuffix");
  await runtime.bot.sendMessage(chatId, [text, suffix].filter(Boolean).join("\n\n"));
  if (runtime.record.botType === "full" && (await rootButtons(runtime)).length > 0) await showButtons(runtime, chatId, Number(msg.from?.id), null);
}

async function sendHome(runtime: ManagedBot, chatId: number, userId: number): Promise<void> {
  const user = await db.select().from(botUsersTable)
    .where(and(eq(botUsersTable.botId, runtime.record.id), eq(botUsersTable.telegramId, String(userId))));
  if (user[0]?.isBanned) return;
  if (userId !== adminId(runtime)) {
    const missing = await missingSubscriptions(runtime, chatId);
    if (missing.length > 0) {
      await sendSubscriptionPrompt(runtime, chatId);
      return;
    }
  }
  const text = (await setting(runtime.record.id, "startMessage")) || DEFAULT_SETTINGS.startMessage;
  const suffix = await setting(runtime.record.id, "startSuffix");
  await runtime.bot.sendMessage(chatId, [text, suffix].filter(Boolean).join("\n\n"));
  if (runtime.record.botType === "full" && (await rootButtons(runtime)).length > 0) {
    await showButtons(runtime, chatId, userId, null);
  }
}

async function mainCallback(runtime: ManagedBot, query: CallbackQuery): Promise<void> {
  const chatId = query.message?.chat.id;
  if (!chatId) return;
  const userId = query.from.id;
  const data = query.data ?? "";
  await runtime.bot.answerCallbackQuery(query.id).catch(() => {});
  if (userId !== adminId(runtime) && data !== "m:check_subscription") {
    const missing = await missingSubscriptions(runtime, chatId);
    if (missing.length > 0) {
      await runtime.bot.answerCallbackQuery(query.id, { text: "⚠️ اشترك في القنوات أولاً." }).catch(() => {});
      await sendSubscriptionPrompt(runtime, chatId);
      return;
    }
  }
  if (userId === adminId(runtime)) {
    if (data === "m:main") return sendPanel(runtime, chatId, query.message?.message_id);
    if (data === "m:stats") {
      const [total] = await db.select({ count: count() }).from(botUsersTable).where(eq(botUsersTable.botId, runtime.record.id));
      await runtime.bot.editMessageText(`📊 الإحصائيات\n\nالمستخدمون: ${total?.count ?? 0}`, { chat_id: chatId, message_id: query.message!.message_id, reply_markup: { inline_keyboard: [[{ text: "↩️ الرئيسية", callback_data: "m:main" }]] } });
      return;
    }
    if (data === "m:check_subscription") {
      await runtime.bot.answerCallbackQuery(query.id, { text: "لا يحتاج المالك إلى الاشتراك." }).catch(() => {});
      return;
    }
    if (data === "m:commands") return showCommands(runtime, chatId, query.message!.message_id);
    if (data === "m:buttons" && runtime.record.botType === "full") return showButtonsAdmin(runtime, chatId, query.message!.message_id);
    if (data === "m:settings") return showSettingsAdmin(runtime, chatId, query.message!.message_id);
    if (data === "m:setting:startMessage") {
      states.set(stateKey(runtime.record.id, userId), { type: "settings_value", key: "startMessage" });
      await runtime.bot.editMessageText("📨 أرسل رسالة البداية الجديدة:", {
        chat_id: chatId,
        message_id: query.message!.message_id,
        reply_markup: { inline_keyboard: [[{ text: "↩️ الإعدادات", callback_data: "m:settings" }]] },
      });
      return;
    }
    if (data === "m:broadcast") {
      states.set(stateKey(runtime.record.id, userId), { type: "broadcast_content" });
      await runtime.bot.editMessageText("📢 أرسل الرسالة التي تريد إرسالها للمستخدمين.", { chat_id: chatId, message_id: query.message!.message_id, reply_markup: { inline_keyboard: [[{ text: "↩️ الرئيسية", callback_data: "m:main" }]] } });
      return;
    }
    if (data === "m:command_add") {
      states.set(stateKey(runtime.record.id, userId), { type: "command_name" });
      await runtime.bot.editMessageText("⌨️ أرسل اسم الأمر بدون /، مثل: help", { chat_id: chatId, message_id: query.message!.message_id, reply_markup: { inline_keyboard: [[{ text: "↩️ الأوامر", callback_data: "m:commands" }]] } });
      return;
    }
    if (data.startsWith("m:command_manage:")) return manageCommand(runtime, chatId, query.message!.message_id, Number(data.split(":")[2]));
    if (data.startsWith("m:command_addmsg:")) {
      const commandId = Number(data.split(":")[2]);
      states.set(stateKey(runtime.record.id, userId), { type: "command_content", commandId });
      await runtime.bot.editMessageText("📝 أرسل رد الأمر الآن.", { chat_id: chatId, message_id: query.message!.message_id, reply_markup: { inline_keyboard: [[{ text: "↩️ الأمر", callback_data: `m:command_manage:${commandId}` }]] } });
      return;
    }
    if (data === "m:button_add") {
      states.set(stateKey(runtime.record.id, userId), { type: "button_name" });
      await runtime.bot.editMessageText("🔘 أرسل اسم الزر الثابت.", { chat_id: chatId, message_id: query.message!.message_id, reply_markup: { inline_keyboard: [[{ text: "↩️ الأزرار", callback_data: "m:buttons" }]] } });
      return;
    }
    if (data.startsWith("m:button_manage:")) return manageButton(runtime, chatId, query.message!.message_id, Number(data.split(":")[2]));
    if (data.startsWith("m:button_addmsg:")) {
      const buttonId = Number(data.split(":")[2]);
      states.set(stateKey(runtime.record.id, userId), { type: "button_content", buttonId });
      await runtime.bot.editMessageText("📝 أرسل رسالة الزر.", { chat_id: chatId, message_id: query.message!.message_id, reply_markup: { inline_keyboard: [[{ text: "↩️ الزر", callback_data: `m:button_manage:${buttonId}` }]] } });
      return;
    }
  }
  if (data === "m:check_subscription") {
    const missing = await missingSubscriptions(runtime, chatId);
    if (missing.length > 0) {
      await runtime.bot.answerCallbackQuery(query.id, { text: "⚠️ لم تشترك في جميع القنوات بعد." }).catch(() => {});
      await sendSubscriptionPrompt(runtime, chatId);
    } else {
      await runtime.bot.answerCallbackQuery(query.id, { text: "✅ تم التحقق من الاشتراك." }).catch(() => {});
      await sendHome(runtime, chatId, userId);
    }
    return;
  }
  if (data.startsWith("cmd:")) {
    const [, sourceId, rawTarget] = data.split(":");
    const sourceIdNumber = Number(sourceId);
    const target = rawTarget?.toLowerCase();
    const key = commandStackKey(runtime.record.id, userId);
    const stack = navStack.get(key) ?? (Number.isFinite(sourceIdNumber) ? [sourceIdNumber] : []);
    if (target && ["back", "رجوع"].includes(target)) {
      const nextStack = stack.slice(0, -1);
      navStack.set(key, nextStack);
      const previousId = nextStack[nextStack.length - 1];
      if (previousId) await sendCommand(runtime, chatId, userId, previousId);
      else {
        navStack.delete(key);
        await sendHome(runtime, chatId, userId);
      }
      return;
    }
    if (target && ["home", "الرئيسية"].includes(target)) {
      navStack.delete(key);
      await sendHome(runtime, chatId, userId);
      return;
    }
    const [destination] = await db.select().from(customCommandsTable).where(and(
      eq(customCommandsTable.botId, runtime.record.id),
      eq(customCommandsTable.command, (target ?? "").replace(/^\//, "")),
      eq(customCommandsTable.isActive, true),
    ));
    if (destination) {
      navStack.set(key, [...stack, destination.id]);
      await sendCommand(runtime, chatId, userId, destination.id);
    } else if (Number.isFinite(sourceIdNumber)) {
      await sendCommand(runtime, chatId, userId, sourceIdNumber);
    }
  }
}

async function showCommands(runtime: ManagedBot, chatId: number, messageId: number): Promise<void> {
  const commands = await db.select().from(customCommandsTable).where(eq(customCommandsTable.botId, runtime.record.id)).orderBy(asc(customCommandsTable.orderIndex));
  const keyboard: InlineKeyboardButton[][] = [[{ text: "➕ إضافة أمر", callback_data: "m:command_add" }]];
  for (const command of commands) keyboard.push([{ text: `${command.isActive ? "✅" : "❌"} /${command.command}`, callback_data: `m:command_manage:${command.id}` }]);
  keyboard.push([{ text: "↩️ الرئيسية", callback_data: "m:main" }]);
  await runtime.bot.editMessageText(`⌨️ الأوامر (${commands.length})`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
}

async function manageCommand(runtime: ManagedBot, chatId: number, messageId: number, commandId: number): Promise<void> {
  const [command] = await db.select().from(customCommandsTable).where(and(eq(customCommandsTable.id, commandId), eq(customCommandsTable.botId, runtime.record.id)));
  if (!command) return showCommands(runtime, chatId, messageId);
  const [messages] = await db.select({ count: count() }).from(commandMessagesTable).where(eq(commandMessagesTable.commandId, commandId));
  await runtime.bot.editMessageText(`⌨️ /${command.command}\nالردود: ${messages?.count ?? 0}`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [
    [{ text: "📝 إضافة رد", callback_data: `m:command_addmsg:${commandId}` }],
    [{ text: "↩️ الأوامر", callback_data: "m:commands" }],
  ] } });
}

async function showButtonsAdmin(runtime: ManagedBot, chatId: number, messageId: number): Promise<void> {
  const buttons = await rootButtons(runtime);
  const keyboard: InlineKeyboardButton[][] = [[{ text: "➕ إضافة زر", callback_data: "m:button_add" }]];
  for (const button of buttons) keyboard.push([{ text: `✅ ${button.label}`, callback_data: `m:button_manage:${button.id}` }]);
  keyboard.push([{ text: "↩️ الرئيسية", callback_data: "m:main" }]);
  await runtime.bot.editMessageText(`🔘 الأزرار الثابتة (${buttons.length})`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
}

async function manageButton(runtime: ManagedBot, chatId: number, messageId: number, buttonId: number): Promise<void> {
  const [button] = await db.select().from(fixedButtonsTable).where(and(eq(fixedButtonsTable.id, buttonId), eq(fixedButtonsTable.botId, runtime.record.id)));
  if (!button) return showButtonsAdmin(runtime, chatId, messageId);
  const [messages] = await db.select({ count: count() }).from(buttonMessagesTable).where(eq(buttonMessagesTable.buttonId, buttonId));
  await runtime.bot.editMessageText(`🔘 ${button.label}\nالرسائل: ${messages?.count ?? 0}`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [
    [{ text: "📝 إضافة رسالة", callback_data: `m:button_addmsg:${buttonId}` }],
    [{ text: "↩️ الأزرار", callback_data: "m:buttons" }],
  ] } });
}

async function showSettingsAdmin(runtime: ManagedBot, chatId: number, messageId: number): Promise<void> {
  const start = await setting(runtime.record.id, "startMessage");
  await runtime.bot.editMessageText(`⚙️ الإعدادات\nرسالة البداية: ${start.slice(0, 80)}`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [
    [{ text: "📨 تعديل رسالة البداية", callback_data: "m:setting:startMessage" }],
    [{ text: "↩️ الرئيسية", callback_data: "m:main" }],
  ] } });
}

async function handleText(runtime: ManagedBot, msg: Message, user: typeof botUsersTable.$inferSelect | undefined): Promise<boolean> {
  if (!msg.from) return false;
  const key = stateKey(runtime.record.id, msg.from.id);
  const current = states.get(key) ?? { type: "idle" as const };
  const text = msg.text ?? "";
  if (msg.from.id === adminId(runtime) && current.type !== "idle") {
    if (current.type === "command_name") {
      const command = text.replace(/^\/+/, "").trim().toLowerCase();
      if (!/^[a-z0-9_]{1,32}$/.test(command)) { await runtime.bot.sendMessage(msg.chat.id, "❌ اسم الأمر غير صالح."); return true; }
      const [created] = await db.insert(customCommandsTable).values({ botId: runtime.record.id, command, title: `/${command}`, isActive: true }).returning();
      states.set(key, { type: "command_content", commandId: created!.id });
      await runtime.bot.sendMessage(msg.chat.id, "✅ تم إنشاء الأمر. أرسل الرد الأول.");
      return true;
    }
    if (current.type === "command_content") {
      const detected = detectManagedContent(msg);
      if (!detected) return true;
      states.set(key, { type: "command_inline", commandId: current.commandId, ...detected });
      await runtime.bot.sendMessage(msg.chat.id, "أرسل الأزرار بصيغة نص الزر = command:اسم_الأمر أو اضغط تخطي بإرسال: لا");
      return true;
    }
    if (current.type === "command_inline") {
      const rows = await db.select({ count: count() }).from(commandMessagesTable).where(eq(commandMessagesTable.commandId, current.commandId));
      await db.insert(commandMessagesTable).values({
        commandId: current.commandId,
        messageType: current.messageType,
        content: current.content,
        caption: current.caption ?? null,
        contentEntities: current.contentEntities ?? null,
        captionEntities: current.captionEntities ?? null,
        forwardData: current.forwardData ?? null,
        inlineButtons: text === "لا" ? null : text,
        orderIndex: Number(rows[0]?.count ?? 0),
      });
      states.set(key, { type: "idle" });
      await runtime.bot.sendMessage(msg.chat.id, "✅ تمت إضافة الرد.", { reply_markup: ownerPanel(runtime) });
      return true;
    }
    if (current.type === "button_name") {
      const [created] = await db.insert(fixedButtonsTable).values({ botId: runtime.record.id, label: text.trim(), token: `${runtime.record.id}-${Date.now()}`, rowGroup: 0, orderIndex: 0, isActive: true }).returning();
      states.set(key, { type: "button_content", buttonId: created!.id });
      await runtime.bot.sendMessage(msg.chat.id, "✅ تم إنشاء الزر. أرسل رسالته.");
      return true;
    }
    if (current.type === "button_content") {
      await db.insert(buttonMessagesTable).values({ botId: runtime.record.id, buttonId: current.buttonId, messageType: "text", content: text, orderIndex: 0 });
      states.set(key, { type: "idle" });
      await runtime.bot.sendMessage(msg.chat.id, "✅ تمت إضافة رسالة الزر.", { reply_markup: ownerPanel(runtime) });
      return true;
    }
    if (current.type === "broadcast_content") {
      const users = await db.select().from(botUsersTable).where(and(eq(botUsersTable.botId, runtime.record.id), eq(botUsersTable.isBlockedBot, false)));
      for (const target of users) {
        await runtime.bot.sendMessage(Number(target.telegramId), text).catch(() => {});
      }
      states.set(key, { type: "idle" });
      await runtime.bot.sendMessage(msg.chat.id, `✅ تم الإرسال إلى ${users.length} مستخدم.`, { reply_markup: ownerPanel(runtime) });
      return true;
    }
    if (current.type === "settings_value") {
      await saveSetting(runtime.record.id, current.key, text);
      states.set(key, { type: "idle" });
      await runtime.bot.sendMessage(msg.chat.id, "✅ تم حفظ الإعداد.", { reply_markup: ownerPanel(runtime) });
      return true;
    }
  }
  if (runtime.record.botType === "full" && user && msg.text) {
    if (msg.from.id !== adminId(runtime) && (await missingSubscriptions(runtime, msg.chat.id)).length > 0) {
      await sendSubscriptionPrompt(runtime, msg.chat.id);
      return true;
    }
    const stack = replyKeyboardState.get(key) ?? [];
    const parentId = stack[stack.length - 1] ?? null;
    if ([NAV_HOME, NAV_BACK].includes(msg.text)) {
      await showButtons(runtime, msg.chat.id, msg.from.id, msg.text === NAV_HOME ? null : null);
      return true;
    }
    const [button] = await db.select().from(fixedButtonsTable).where(and(eq(fixedButtonsTable.botId, runtime.record.id), eq(fixedButtonsTable.label, msg.text), eq(fixedButtonsTable.isActive, true), parentId === null ? isNull(fixedButtonsTable.parentId) : eq(fixedButtonsTable.parentId, parentId)));
    if (button) {
      const children = await db.select({ id: fixedButtonsTable.id }).from(fixedButtonsTable).where(and(eq(fixedButtonsTable.botId, runtime.record.id), eq(fixedButtonsTable.parentId, button.id), eq(fixedButtonsTable.isActive, true)));
      if (children.length) {
        await showButtons(runtime, msg.chat.id, msg.from.id, button.id);
        return true;
      }
      const messages = await db.select().from(buttonMessagesTable).where(and(eq(buttonMessagesTable.botId, runtime.record.id), eq(buttonMessagesTable.buttonId, button.id))).orderBy(asc(buttonMessagesTable.orderIndex));
      for (const message of messages) await sendBotMessage(msg.chat.id, message.messageType, message.content, message.caption ?? undefined, message.inlineButtons ?? undefined, false, { botOverride: runtime.bot });
      return true;
    }
  }
  if (runtime.record.botType === "contact" && msg.from.id !== adminId(runtime)) {
    if ((await missingSubscriptions(runtime, msg.chat.id)).length > 0) {
      await sendSubscriptionPrompt(runtime, msg.chat.id);
      return true;
    }
    await runtime.bot.forwardMessage(adminId(runtime), msg.chat.id, msg.message_id).catch(() => {});
    await runtime.bot.sendMessage(msg.chat.id, "✅ تم إرسال رسالتك إلى مالك البوت.");
    return true;
  }
  return false;
}

export async function startManagedBot(record: typeof botInstancesTable.$inferSelect): Promise<void> {
  if (runtimes.has(record.id)) return;
  const token = decryptBotToken(record.tokenEncrypted);
  const bot = new TelegramBot(token, { polling: true });
  const me = await bot.getMe();
  const runtime: ManagedBot = { record, bot, username: me.username ?? "" };
  runtimes.set(record.id, runtime);
  await db.update(botInstancesTable).set({ username: me.username ?? null, isActive: true }).where(eq(botInstancesTable.id, record.id));
  bot.on("polling_error", err => logger.error({ err, botId: record.id }, "Managed bot polling error"));
  bot.onText(/^\/start(?:@([A-Za-z0-9_]+))?/, async msg => {
    if (msg.text?.includes("@") && !msg.text.toLowerCase().includes(`@${runtime.username.toLowerCase()}`)) return;
    const user = await registerUser(runtime, msg);
    await sendStart(runtime, msg, user);
  });
  bot.on("callback_query", query => mainCallback(runtime, query).catch(err => logger.error({ err, botId: record.id }, "Managed callback error")));
  bot.on("message", async msg => {
    if (msg.from?.id !== adminId(runtime) && msg.from && (await missingSubscriptions(runtime, msg.chat.id)).length > 0) {
      if (!msg.text?.startsWith("/start")) await sendSubscriptionPrompt(runtime, msg.chat.id);
      return;
    }
    if (msg.text?.startsWith("/")) {
      const match = msg.text.match(/^\/([A-Za-z0-9_]+)/);
      const command = match?.[1]?.toLowerCase();
      if (command === "start") return;
      if (command === "panel" && msg.from?.id === adminId(runtime)) return sendPanel(runtime, msg.chat.id);
      if (command) {
        const [custom] = await db.select().from(customCommandsTable).where(and(eq(customCommandsTable.botId, record.id), eq(customCommandsTable.command, command), eq(customCommandsTable.isActive, true)));
        if (custom) {
          const user = await registerUser(runtime, msg);
          if (!user?.isBanned) {
            navStack.set(commandStackKey(record.id, msg.from!.id), [custom.id]);
            await sendCommand(runtime, msg.chat.id, msg.from!.id, custom.id);
          }
          return;
        }
      }
    }
    const user = await registerUser(runtime, msg);
    await handleText(runtime, msg, user);
  });
  logger.info({ botId: record.id, botUsername: runtime.username, botType: record.botType }, "Managed bot started");
}

export async function startManagedBots(): Promise<void> {
  const records = await db.select().from(botInstancesTable).where(eq(botInstancesTable.isActive, true));
  for (const record of records) {
    await startManagedBot(record).catch(err => logger.error({ err, botId: record.id }, "Managed bot failed to start"));
  }
}

export async function stopManagedBot(botId: number): Promise<void> {
  const runtime = runtimes.get(botId);
  if (!runtime) return;
  await runtime.bot.stopPolling().catch(() => {});
  runtimes.delete(botId);
}

export async function broadcastManagedBot(botId: number, content: string): Promise<{ sent: number; available: boolean }> {
  const runtime = runtimes.get(botId);
  if (!runtime) return { sent: 0, available: false };
  const users = await db.select().from(botUsersTable).where(and(
    eq(botUsersTable.botId, botId),
    eq(botUsersTable.isBlockedBot, false),
  ));
  let sent = 0;
  for (const user of users) {
    const delivered = await runtime.bot.sendMessage(Number(user.telegramId), content).then(() => true).catch(() => false);
    if (delivered) sent++;
  }
  return { sent, available: true };
}