import TelegramBot from "node-telegram-bot-api";
import type { Message, KeyboardButton, InlineKeyboardButton } from "node-telegram-bot-api";
import { db, usersTable, fixedButtonsTable, buttonMessagesTable, channelsTable, customCommandsTable, commandMessagesTable } from "@workspace/db";
import { eq, and, asc, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { buildInlineMarkup } from "./keyboard";
import { getSettings } from "./settings-cache";
import { handleAdminCallback, handleAdminText, handleBtnMsgsEditOpen, handleAdminMediaGroup } from "./admin/panel";
import { MAIN_MENU } from "./admin/menu";
import { getBot, getBotUsername, setBot, setBotUsername } from "./bot-info";
import { getState } from "./admin/state";
import { sendBotMessage, broadcastMessage, textFormatting } from "./send";
export { sendBotMessage, broadcastMessage };

const TOKEN = process.env["BOT_TOKEN"];
export const OWNER_ID = process.env["OWNER_ID"] ? parseInt(process.env["OWNER_ID"]) : 5070528919;

function adminIsCapturingText(userId: number | undefined): boolean {
  if (userId !== OWNER_ID) return false;
  const stateType = getState(userId).type;
  return new Set([
    "broadcast_wait_content",
    "button_msg_wait_content",
    "button_msg_edit_wait_content",
    "command_wait_name",
    "command_msg_wait_content",
    "command_msg_wait_inline",
    "setting_wait_value",
    "button_wait_label",
    "button_wait_sub_label",
    "button_set_row",
    "button_set_autodelete",
    "channel_wait_id",
    "channel_wait_name",
    "channel_wait_url",
    "user_ban_wait",
    "user_unban_wait",
  ]).has(stateType);
}

function commandBelongsToThisBot(mention?: string): boolean {
  const username = getBotUsername();
  return !mention || !username || mention.toLowerCase() === username.toLowerCase();
}

// ── Media-group buffer ─────────────────────────────────────────────────────
// Telegram sends each photo/video in an album as a separate message event with
// the same media_group_id. We buffer them for 1.2 s then process as one group.
const _mediaGroupBuffer = new Map<string, { msgs: Message[]; timer: ReturnType<typeof setTimeout> }>();

function collectMediaGroup(msg: Message, onComplete: (msgs: Message[]) => void): void {
  const gid = msg.media_group_id!;
  const existing = _mediaGroupBuffer.get(gid);
  if (existing) {
    clearTimeout(existing.timer);
    existing.msgs.push(msg);
    existing.timer = setTimeout(() => { _mediaGroupBuffer.delete(gid); onComplete(existing.msgs); }, 1200);
  } else {
    const entry: { msgs: Message[]; timer: ReturnType<typeof setTimeout> } = { msgs: [msg], timer: null! };
    entry.timer = setTimeout(() => { _mediaGroupBuffer.delete(gid); onComplete(entry.msgs); }, 1200);
    _mediaGroupBuffer.set(gid, entry);
  }
}

// ── Navigation constants ────────────────────────────────────────────────────
const NAV_BACK = "🔙 رجوع";
const NAV_HOME = "🏠 الرئيسية";
const NAV_PREV = "◀️ السابق";
const NAV_NEXT = "التالي ▶️";
export const NAV_LABELS = new Set([NAV_BACK, NAV_HOME, NAV_PREV, NAV_NEXT]);
const PAGE_SIZE = 20;

// Per-user navigation state (parentStack = stack of parent button IDs, empty = root)
interface UserNavState { parentStack: number[]; page: number; }
const userNavState = new Map<number, UserNavState>();
const commandNavState = new Map<number, number[]>();
function getNavState(userId: number): UserNavState {
  return userNavState.get(userId) ?? { parentStack: [], page: 0 };
}

export async function startBot() {
  if (!TOKEN) { logger.warn("BOT_TOKEN not set, bot will not start"); return; }

  const bot = new TelegramBot(TOKEN, { polling: true });
  setBot(bot);

  try {
    const me = await bot.getMe();
    setBotUsername(me.username ?? "");
    logger.info({ botUsername: me.username }, "Bot username fetched");
  } catch { /* ignore */ }

  bot.on("polling_error", (err) => { logger.error({ err }, "Telegram polling error"); });

  // ── /start ─────────────────────────────────────────────────────────────────
  bot.onText(/^\/start(?:@([A-Za-z0-9_]+))?(?:[ \t]+(.+?))?[ \t]*$/, async (msg, match) => { try {
    if (!commandBelongsToThisBot(match?.[1]) || adminIsCapturingText(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId) return;

    const param = (match?.[2] ?? "").trim();

    // Deep-link for fixed button token
    if (param) {
      const [fbtn] = await db.select().from(fixedButtonsTable)
        .where(and(eq(fixedButtonsTable.token, param), eq(fixedButtonsTable.isActive, true)));
      if (fbtn) {
        const settings = await getSettings();
        const messages = await db.select().from(buttonMessagesTable)
          .where(eq(buttonMessagesTable.buttonId, fbtn.id))
          .orderBy(asc(buttonMessagesTable.orderIndex));
        for (const m of messages) {
          await sendBotMessage(chatId, m.messageType, m.content, m.caption ?? undefined, m.inlineButtons ?? undefined, settings.contentProtection || undefined, {
            contentEntities: m.contentEntities,
            captionEntities: m.captionEntities,
            forwardData: m.forwardData,
          });
        }
        return;
      }
    }

    await registerUser(msg);
    const settings = await getSettings();

    if (userId === OWNER_ID) {
      // Reset navigation for admin re-entering
      userNavState.set(userId, { parentStack: [], page: 0 });
      await sendStart(chatId, settings, true);
      return;
    }

    const [userRecord] = await db.select().from(usersTable).where(eq(usersTable.telegramId, String(userId)));
    if (userRecord?.isBanned) { await bot!.sendMessage(chatId, "تم حظرك من استخدام هذا البوت."); return; }

    const notSubscribed = await checkSubscriptions(chatId);
    if (notSubscribed.length > 0) {
      await bot!.sendMessage(chatId, await buildSubText(settings.subscriptionMessage), {
        reply_markup: buildSubMarkup(notSubscribed),
        ...textFormatting(settings.subscriptionMessage, settings.subscriptionMessageEntities),
      });
      return;
    }

    userNavState.set(userId, { parentStack: [], page: 0 });
    await sendStart(chatId, settings, false);
  } catch (err) { logger.error({ err }, "/start handler error"); }});

  // ── /menu ──────────────────────────────────────────────────────────────────
  bot.onText(/^\/menu(?:@([A-Za-z0-9_]+))?[ \t]*$/, async (msg, match) => { try {
    if (!commandBelongsToThisBot(match?.[1]) || adminIsCapturingText(msg.from?.id)) return;
    if (msg.from?.id !== OWNER_ID) return;
    await bot!.sendMessage(msg.chat.id, "🎛️ لوحة التحكم", { reply_markup: MAIN_MENU });
  } catch (err) { logger.error({ err }, "/menu handler error"); }});

  // Custom commands are available to all non-admin users after the normal checks.
  bot.onText(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:[ \t]+.*)?$/, async (msg, match) => { try {
    if (!commandBelongsToThisBot(match?.[2]) || adminIsCapturingText(msg.from?.id)) return;
    const command = (match?.[1] ?? "").toLowerCase();
    if (["start", "menu"].includes(command)) return;
    const userId = msg.from?.id;
    if (!userId || userId === OWNER_ID) return;
    const [userRecord] = await db.select().from(usersTable).where(eq(usersTable.telegramId, String(userId)));
    if (!userRecord || userRecord.isBanned) return;
    const [custom] = await db.select().from(customCommandsTable)
      .where(and(eq(customCommandsTable.command, command), eq(customCommandsTable.isActive, true), isNull(customCommandsTable.botId)));
    if (!custom) return;
    await sendCommandMessages(msg.chat.id, userId, custom.id);
  } catch (err) { logger.error({ err }, "custom command handler error"); }});

  // ── Callback queries ───────────────────────────────────────────────────────
  bot.on("callback_query", async (query) => { try {
    const chatId = query.message?.chat.id;
    const userId = query.from.id;
    if (!chatId) return;
    const data = query.data || "";

    if (userId === OWNER_ID) {
      if (data.startsWith("btn:msgs:edit_open:")) {
        await handleBtnMsgsEditOpen(bot!, query, userId);
      } else {
        await handleAdminCallback(bot!, query, userId);
      }
      return;
    }

    if (data.startsWith("cmd:")) {
      const [userRecord] = await db.select().from(usersTable).where(eq(usersTable.telegramId, String(userId)));
      if (!userRecord || userRecord.isBanned) {
        await bot!.answerCallbackQuery(query.id, { text: "غير مسموح." }).catch(() => {});
        return;
      }
      const [, sourceId, target] = data.split(":");
      const sourceCommandId = parseInt(sourceId ?? "", 10);
      if (Number.isFinite(sourceCommandId)) {
        if (target && ["back", "رجوع"].includes(target.toLowerCase())) {
          const stack = commandNavState.get(userId) ?? [];
          const previous = stack.slice(0, -1);
          commandNavState.set(userId, previous);
          const previousId = previous[previous.length - 1];
          if (previousId) await sendCommandMessages(chatId, userId, previousId);
        } else if (target && ["home", "الرئيسية"].includes(target.toLowerCase())) {
          commandNavState.delete(userId);
          await sendStart(chatId, await getSettings(), false);
        } else if (target) {
          const [destination] = await db.select({ id: customCommandsTable.id }).from(customCommandsTable)
            .where(and(eq(customCommandsTable.command, target.replace(/^\//, "").toLowerCase()), eq(customCommandsTable.isActive, true), isNull(customCommandsTable.botId)));
          if (destination) {
            commandNavState.set(userId, [...(commandNavState.get(userId) ?? [sourceCommandId]), destination.id]);
            await sendCommandMessages(chatId, userId, destination.id);
          }
        } else {
          await sendCommandMessages(chatId, userId, sourceCommandId);
        }
      }
      return;
    }

    if (data === "check_subscription") {
      const [userRecord] = await db.select().from(usersTable).where(eq(usersTable.telegramId, String(userId)));
      if (userRecord?.isBanned) { await bot!.answerCallbackQuery(query.id, { text: "تم حظرك." }); return; }
      const notSubscribed = await checkSubscriptions(chatId);
      if (notSubscribed.length > 0) {
        await bot!.answerCallbackQuery(query.id, { text: "⚠️ لم تشترك في جميع القنوات بعد!" });
        return;
      }
      await bot!.answerCallbackQuery(query.id, { text: "✅ تم التحقق! شكراً." });
      try { await bot!.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message?.message_id }); } catch {}
      const settings = await getSettings();
      userNavState.set(userId, { parentStack: [], page: 0 });
      await sendStart(chatId, settings, false);
      return;
    }

    await bot!.answerCallbackQuery(query.id);
  } catch (err: unknown) {
    const desc = (err as { response?: { body?: { description?: string } } })?.response?.body?.description ?? "";
    if (!desc.includes("message is not modified") && !desc.includes("query is too old")) {
      logger.error({ err }, "callback_query error");
    }
    try { await bot!.answerCallbackQuery(query.id); } catch {}
  }});

  // ── Text messages ──────────────────────────────────────────────────────────
  bot.on("message", async (msg) => { try {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId || (msg.text?.startsWith("/") && !adminIsCapturingText(userId))) return;

    if (userId === OWNER_ID) {
      // Album sent as media group → buffer and process together
      if (msg.media_group_id) {
        collectMediaGroup(msg, async (groupMsgs) => {
          try { await handleAdminMediaGroup(bot!, chatId, userId, groupMsgs); } catch (err) { logger.error({ err }, "handleAdminMediaGroup error"); }
        });
        return;
      }
      const handled = await handleAdminText(bot!, msg, userId);
      if (!handled) {
        await handleFixedButton(chatId, userId, msg.text ?? "");
      }
      return;
    }

    const [userRecord] = await db.select().from(usersTable).where(eq(usersTable.telegramId, String(userId)));
    if (!userRecord || userRecord.isBanned) return;

    const settings = await getSettings();
    const notSubscribed = await checkSubscriptions(chatId);
    if (notSubscribed.length > 0) {
      await bot!.sendMessage(chatId, await buildSubText(settings.subscriptionMessage), {
        reply_markup: buildSubMarkup(notSubscribed),
        ...textFormatting(settings.subscriptionMessage, settings.subscriptionMessageEntities),
      });
      return;
    }

    if (!msg.text) return;
    await handleFixedButton(chatId, userId, msg.text);
  } catch (err) { logger.error({ err }, "message handler error"); }});

  // ── Contact ────────────────────────────────────────────────────────────────
  bot.on("contact", async (msg) => { try {
    const userId = msg.from?.id;
    if (!userId || !msg.contact?.phone_number) return;
    await db.update(usersTable).set({ phone: msg.contact.phone_number }).where(eq(usersTable.telegramId, String(userId)));
  } catch (err) { logger.error({ err }, "contact handler error"); }});

  process.on("uncaughtException", (err) => { logger.error({ err }, "Uncaught exception"); });
  process.on("unhandledRejection", (reason) => { logger.error({ reason }, "Unhandled rejection"); });

  logger.info("Telegram bot started successfully");
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function registerUser(msg: Message) {
  if (!msg.from) return;
  const f = msg.from;
  await db.insert(usersTable)
    .values({ telegramId: String(f.id), username: f.username ?? null, firstName: f.first_name ?? null, lastName: f.last_name ?? null })
    .onConflictDoUpdate({ target: usersTable.telegramId, set: { username: f.username ?? null, firstName: f.first_name ?? null, lastName: f.last_name ?? null, updatedAt: new Date() } });
}

/**
 * Build the reply keyboard for a given set of buttons, with pagination and navigation rows.
 * parentStack is the current navigation breadcrumb (used to show back/home buttons).
 */
function buildReplyKeyboard(
  buttons: Array<{ rowGroup: number; orderIndex: number; label: string }>,
  page: number,
  parentStack: number[],
): KeyboardButton[][] {
  const sorted = [...buttons].sort((a, b) =>
    a.rowGroup !== b.rowGroup ? a.rowGroup - b.rowGroup : a.orderIndex - b.orderIndex
  );
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE) || 1;
  const p = Math.min(page, totalPages - 1);
  const pageBtns = sorted.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);

  // Group by rowGroup
  const groups = new Map<number, string[]>();
  for (const btn of pageBtns) {
    const g = groups.get(btn.rowGroup) ?? [];
    g.push(btn.label);
    groups.set(btn.rowGroup, g);
  }
  const keyboard: KeyboardButton[][] = Array.from(groups.values()).map(labels => labels.map(text => ({ text })));

  // Pagination row
  const pageRow: KeyboardButton[] = [];
  if (p > 0) pageRow.push({ text: NAV_PREV });
  if (p < totalPages - 1) pageRow.push({ text: NAV_NEXT });
  if (pageRow.length > 0) keyboard.push(pageRow);

  // Back / Home row (only when inside a sub-menu)
  if (parentStack.length > 0) {
    const backRow: KeyboardButton[] = [{ text: NAV_BACK }];
    if (parentStack.length > 1) backRow.push({ text: NAV_HOME });
    keyboard.push(backRow);
  }

  return keyboard;
}

/** Show the reply keyboard for a given navigation level. */
async function showNavLevel(chatId: number, userId: number, parentId: number | null, page: number) {
  const settings = await getSettings();
  const b = getBot()!;

  const whereClause = parentId !== null
    ? and(eq(fixedButtonsTable.isActive, true), eq(fixedButtonsTable.parentId, parentId))
    : and(eq(fixedButtonsTable.isActive, true), isNull(fixedButtonsTable.parentId));

  const buttons = await db.select().from(fixedButtonsTable)
    .where(whereClause)
    .orderBy(asc(fixedButtonsTable.rowGroup), asc(fixedButtonsTable.orderIndex));

  if (buttons.length === 0) return;

  const navState = getNavState(userId);
  const keyboard = buildReplyKeyboard(buttons, page, navState.parentStack);
  const text = parentId === null
    ? (settings.fixedButtonsMessage || "استخدم الازرار بالاسفل لتصفح المحتوى")
    : "اختر من القائمة:";

  await b.sendMessage(chatId, text, {
    reply_markup: { keyboard, resize_keyboard: true },
    ...textFormatting(text, parentId === null ? settings.fixedButtonsMessageEntities : undefined),
    ...(settings.contentProtection ? { protect_content: true } : {}),
  });
}

async function sendStart(chatId: number, settings: Awaited<ReturnType<typeof getSettings>>, isAdmin: boolean) {
  // Only root-level buttons (parentId IS NULL) appear in the start keyboard
  const activeButtons = await db.select().from(fixedButtonsTable)
    .where(and(eq(fixedButtonsTable.isActive, true), isNull(fixedButtonsTable.parentId)));
  const inlineMarkup = buildInlineMarkup(settings.startButtons);
  const b = getBot()!;
  const text = settings.startMessage || "مرحباً!";
  const protect = settings.contentProtection ? { protect_content: true } : {};

  if (isAdmin) {
    await b.sendMessage(chatId, "🎛️ لوحة التحكم:", { reply_markup: MAIN_MENU, ...protect });
  }

  await b.sendMessage(chatId, text, {
    ...textFormatting(text, settings.startMessageEntities),
    ...(inlineMarkup ? { reply_markup: inlineMarkup } : {}),
    ...protect,
  });

  if (activeButtons.length > 0) {
    const keyboard = buildReplyKeyboard(activeButtons, 0, []);
    await b.sendMessage(chatId, settings.fixedButtonsMessage || "استخدم الازرار بالاسفل لتصفح المحتوى", {
      reply_markup: { keyboard, resize_keyboard: true },
      ...textFormatting(settings.fixedButtonsMessage, settings.fixedButtonsMessageEntities),
      ...protect,
    });
  }
}

async function checkSubscriptions(chatId: number) {
  const channels = await db.select().from(channelsTable).where(eq(channelsTable.isActive, true));
  const notSubscribed: typeof channels = [];
  for (const ch of channels) {
    try {
      const member = await getBot()!.getChatMember(ch.channelId, chatId);
      if (!["member", "administrator", "creator"].includes(member.status)) notSubscribed.push(ch);
    } catch { notSubscribed.push(ch); }
  }
  return notSubscribed;
}

async function buildSubText(subMessage: string): Promise<string> {
  return subMessage || "يجب عليك الاشتراك في القنوات التالية أولاً:";
}

function buildSubMarkup(channels: { channelName: string; channelUrl: string | null; channelUsername: string | null; channelId: string }[]): { inline_keyboard: InlineKeyboardButton[][] } {
  const keyboard: InlineKeyboardButton[][] = channels.map(ch => [{
    text: `📢 اشترك في ${ch.channelName}`,
    url: ch.channelUrl || (ch.channelUsername ? `https://t.me/${ch.channelUsername}` : ch.channelId),
  }]);
  keyboard.push([{ text: "✅ تحققت من الاشتراك", callback_data: "check_subscription" }]);
  return { inline_keyboard: keyboard };
}

/** Handle a text message that might be a fixed button or navigation command. */
async function handleFixedButton(chatId: number, userId: number, text: string) {
  const b = getBot()!;
  const navState = getNavState(userId);

  // Navigation commands
  if (text === NAV_HOME) {
    userNavState.set(userId, { parentStack: [], page: 0 });
    await showNavLevel(chatId, userId, null, 0);
    return;
  }
  if (text === NAV_BACK) {
    const newStack = navState.parentStack.slice(0, -1);
    const newParent = newStack.length > 0 ? newStack[newStack.length - 1]! : null;
    userNavState.set(userId, { parentStack: newStack, page: 0 });
    await showNavLevel(chatId, userId, newParent, 0);
    return;
  }
  if (text === NAV_NEXT) {
    const currentParent = navState.parentStack.length > 0 ? navState.parentStack[navState.parentStack.length - 1]! : null;
    const newPage = navState.page + 1;
    userNavState.set(userId, { ...navState, page: newPage });
    await showNavLevel(chatId, userId, currentParent, newPage);
    return;
  }
  if (text === NAV_PREV) {
    const currentParent = navState.parentStack.length > 0 ? navState.parentStack[navState.parentStack.length - 1]! : null;
    const newPage = Math.max(0, navState.page - 1);
    userNavState.set(userId, { ...navState, page: newPage });
    await showNavLevel(chatId, userId, currentParent, newPage);
    return;
  }

  // Find matching button at current navigation level
  const currentParentId = navState.parentStack.length > 0 ? navState.parentStack[navState.parentStack.length - 1]! : null;
  const whereClause = currentParentId !== null
    ? and(eq(fixedButtonsTable.isActive, true), eq(fixedButtonsTable.label, text), eq(fixedButtonsTable.parentId, currentParentId))
    : and(eq(fixedButtonsTable.isActive, true), eq(fixedButtonsTable.label, text), isNull(fixedButtonsTable.parentId));

  const [button] = await db.select().from(fixedButtonsTable).where(whereClause);
  if (!button) return;

  // Check for active children → navigate into sub-menu
  const children = await db.select({ id: fixedButtonsTable.id }).from(fixedButtonsTable)
    .where(and(eq(fixedButtonsTable.parentId, button.id), eq(fixedButtonsTable.isActive, true)));

  if (children.length > 0) {
    const newStack = [...navState.parentStack, button.id];
    userNavState.set(userId, { parentStack: newStack, page: 0 });
    await showNavLevel(chatId, userId, button.id, 0);
    return;
  }

  // Leaf button → send its messages
  const settings = await getSettings();
  const messages = await db.select().from(buttonMessagesTable)
    .where(eq(buttonMessagesTable.buttonId, button.id))
    .orderBy(asc(buttonMessagesTable.orderIndex));

  const sentIds: number[] = [];
  for (const m of messages) {
    const result = await sendBotMessage(
      chatId, m.messageType, m.content,
      m.caption ?? undefined, m.inlineButtons ?? undefined,
      settings.contentProtection || undefined,
      {
        contentEntities: m.contentEntities,
        captionEntities: m.captionEntities,
        forwardData: m.forwardData,
      },
    );
    if (result !== undefined) {
      if (Array.isArray(result)) sentIds.push(...result);
      else sentIds.push(result);
    }
  }

  // Schedule auto-delete if configured
  if (button.autoDeleteSeconds && button.autoDeleteSeconds > 0 && sentIds.length > 0) {
    const delay = button.autoDeleteSeconds * 1000;
    setTimeout(async () => {
      for (const mid of sentIds) {
        try { await b.deleteMessage(chatId, mid); } catch {}
      }
    }, delay);
  }
}

async function sendCommandMessages(chatId: number, userId: number, commandId: number) {
  const settings = await getSettings();
  const messages = await db.select().from(commandMessagesTable)
    .where(eq(commandMessagesTable.commandId, commandId))
    .orderBy(asc(commandMessagesTable.orderIndex));
  for (const message of messages) {
    await sendBotMessage(chatId, message.messageType, message.content, message.caption ?? undefined,
      message.inlineButtons ?? undefined, settings.contentProtection || undefined, {
        contentEntities: message.contentEntities,
        captionEntities: message.captionEntities,
        forwardData: message.forwardData,
        interactiveCommandId: commandId,
      });
  }
}
