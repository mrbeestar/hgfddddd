import TelegramBot from "node-telegram-bot-api";
import type { InlineKeyboardButton, CallbackQuery, Message } from "node-telegram-bot-api";
import { db, usersTable, fixedButtonsTable, buttonMessagesTable, channelsTable, broadcastsTable, customCommandsTable, commandMessagesTable } from "@workspace/db";
import { eq, desc, count, gte, asc, isNull, and } from "drizzle-orm";
import { randomBytes } from "crypto";
import { getState, setState, resetState } from "./state";
import {
  MAIN_MENU, BACK_MAIN, COMMANDS_MENU,
  USERS_MENU, settingMeta, buildSettingsMenu, buildAutoDeleteMenu, formatAutoDelete,
} from "./menu";
import { buildInlineMarkup } from "../keyboard";
import { getSettings, invalidateCache, saveSetting, DEFAULTS } from "../settings-cache";
import { broadcastMessage, sendBotMessage, textFormatting } from "../send";
import { getBotUsername } from "../bot-info";

function generateToken(): string {
  return randomBytes(6).toString("hex");
}

export function getTypeLabel(type: string): string {
  const labels: Record<string, string> = { text: "نص", photo: "صورة", video: "فيديو", audio: "صوت", document: "ملف", animation: "GIF", voice: "رسالة صوتية", video_note: "فيديو دائري", sticker: "ملصق", location: "موقع", venue: "مكان", contact: "جهة اتصال", poll: "استطلاع", dice: "نرد", media_group: "ألبوم", forward: "توجيه" };
  return labels[type] ?? type;
}

// ── Main callback router ───────────────────────────────────────────────────
export async function handleAdminCallback(bot: TelegramBot, query: CallbackQuery, adminId: number) {
  const chatId = query.message!.chat.id;
  const msgId = query.message!.message_id;
  const data = query.data || "";

  await bot.answerCallbackQuery(query.id).catch(() => {});

  // ── Main menu ──────────────────────────────────────────────────────────
  if (data === "menu:main") { resetState(adminId); await showMainMenu(bot, chatId, msgId); return; }
  if (data === "menu:stats") { await showStats(bot, chatId, msgId); return; }
  if (data === "menu:users") { resetState(adminId); await showUsersMenu(bot, chatId, msgId); return; }
  if (data === "menu:buttons") { resetState(adminId); await showButtonsList(bot, chatId, msgId); return; }
  if (data === "menu:commands") { resetState(adminId); await showCommandsList(bot, chatId, msgId); return; }
  if (data === "menu:channels") { resetState(adminId); await showChannelsList(bot, chatId, msgId); return; }
  if (data === "menu:settings") { resetState(adminId); await showSettingsMenu(bot, chatId, msgId); return; }

  // ── Broadcast ──────────────────────────────────────────────────────────
  if (data === "menu:broadcast") {
    setState(adminId, { type: "broadcast_wait_content" });
    await bot.editMessageText("📢 الإذاعة\n\nأرسل الرسالة مباشرة الآن.\n\nسيتعرف البوت تلقائياً على نوع المحتوى، ويحافظ على تنسيق تيليجرام والتوجيهات كما هي.", {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: "menu:broadcast" }]] },
    });
    return;
  }
  // Support old admin-menu buttons by routing them to the new automatic flow.
  if (data.startsWith("type:")) {
    setState(adminId, { type: "broadcast_wait_content" });
    await bot.editMessageText("📢 أرسل الرسالة مباشرة الآن، وسيكتشف البوت نوعها تلقائياً.", {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: "menu:broadcast" }]] },
    });
    return;
  }
  if (data === "broadcast:skip_caption") {
    const state = getState(adminId);
    if (state.type === "broadcast_wait_caption") {
      setState(adminId, { type: "broadcast_wait_inline", msgType: state.msgType, content: state.content });
      await bot.editMessageText("هل تريد أزرار شفافة؟ أرسلها أو:", {
        chat_id: chatId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: "⏭️ بدون أزرار", callback_data: "broadcast:skip_inline" }], [{ text: "↩️ رجوع", callback_data: "menu:broadcast" }]] },
      });
    }
    return;
  }
  if (data === "broadcast:skip_inline") {
    const state = getState(adminId);
    if (state.type === "broadcast_wait_inline") {
      setState(adminId, {
        type: "broadcast_confirm",
        msgType: state.msgType,
        content: state.content,
        caption: state.caption,
        contentEntities: state.contentEntities,
        captionEntities: state.captionEntities,
        forwardData: state.forwardData,
      });
      await showBroadcastConfirm(bot, chatId, msgId, state.msgType, state.content, state.caption);
    }
    return;
  }
  if (data === "broadcast:send") {
    const state = getState(adminId);
    if (state.type === "broadcast_confirm") {
      resetState(adminId);
      await bot.editMessageText("📤 جاري الإرسال...", { chat_id: chatId, message_id: msgId });
      const cnt = await broadcastMessage(
        state.msgType,
        state.content,
        state.caption,
        state.inlineButtons,
        {
          contentEntities: state.contentEntities,
          captionEntities: state.captionEntities,
          forwardData: state.forwardData,
        },
      );
      await db.insert(broadcastsTable).values({
        messageType: state.msgType,
        content: state.content,
        caption: state.caption ?? null,
        contentEntities: state.contentEntities ?? null,
        captionEntities: state.captionEntities ?? null,
        forwardData: state.forwardData ?? null,
        inlineButtons: state.inlineButtons ?? null,
        recipientCount: cnt,
      });
      await bot.editMessageText(`✅ تم الإرسال!\nعدد المستقبلين: ${cnt}`, {
        chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[BACK_MAIN]] },
      });
    }
    return;
  }

  // ── Users ──────────────────────────────────────────────────────────────
  if (data.startsWith("users:list:")) { await showUsersList(bot, chatId, msgId, parseInt(data.slice(11)!) || 0, false); return; }
  if (data.startsWith("users:banned:")) { await showUsersList(bot, chatId, msgId, parseInt(data.slice(13)!) || 0, true); return; }
  if (data === "users:ban") { setState(adminId, { type: "user_ban_wait" }); await bot.editMessageText("🔨 أرسل ID المستخدم المراد حظره:", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: "menu:users" }]] } }); return; }
  if (data === "users:unban") { setState(adminId, { type: "user_unban_wait" }); await bot.editMessageText("✅ أرسل ID المستخدم لرفع حظره:", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: "menu:users" }]] } }); return; }
  if (data === "users:unban_all") { await db.update(usersTable).set({ isBanned: false }); await bot.editMessageText("✅ تم رفع الحظر عن الجميع.", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "↩️ المستخدمون", callback_data: "menu:users" }]] } }); return; }
  if (data.startsWith("users:doban:")) { await db.update(usersTable).set({ isBanned: true }).where(eq(usersTable.telegramId, data.slice(12)!)); await bot.editMessageText(`✅ تم الحظر.`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "↩️ المستخدمون", callback_data: "menu:users" }]] } }); return; }
  if (data.startsWith("users:dounban:")) { await db.update(usersTable).set({ isBanned: false }).where(eq(usersTable.telegramId, data.slice(14)!)); await bot.editMessageText(`✅ تم رفع الحظر.`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "↩️ المستخدمون", callback_data: "menu:users" }]] } }); return; }

  // ── Fixed buttons ──────────────────────────────────────────────────────
  if (data === "btn:add") {
    setState(adminId, { type: "button_wait_label" });
    await bot.editMessageText("🔘 أرسل نص (اسم) الزر الجديد:", {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: "menu:buttons" }]] },
    });
    return;
  }
  if (data.startsWith("btn:manage:")) { await showButtonManage(bot, chatId, msgId, parseInt(data.slice(11)!)); return; }
  if (data.startsWith("btn:toggle:")) {
    const btnId = parseInt(data.slice(11)!);
    const [btn] = await db.select().from(fixedButtonsTable).where(eq(fixedButtonsTable.id, btnId));
    if (btn) await db.update(fixedButtonsTable).set({ isActive: !btn.isActive }).where(eq(fixedButtonsTable.id, btnId));
    await showButtonManage(bot, chatId, msgId, btnId);
    return;
  }
  if (data.startsWith("btn:delete:")) {
    const btnId = parseInt(data.slice(11)!);
    await db.delete(fixedButtonsTable).where(eq(fixedButtonsTable.id, btnId));
    await showButtonsList(bot, chatId, msgId);
    return;
  }
  if (data.startsWith("btn:regen_token:")) {
    const btnId = parseInt(data.slice(16)!);
    const newToken = generateToken();
    await db.update(fixedButtonsTable).set({ token: newToken }).where(eq(fixedButtonsTable.id, btnId));
    await showButtonManage(bot, chatId, msgId, btnId);
    return;
  }
  // ── Fixed button: show auto-delete presets menu ──────────────────────────
  if (data.startsWith("btn:autodel_menu:")) {
    const btnId = parseInt(data.slice(17)!);
    await bot.editMessageText("⏱️ اختر مدة الحذف التلقائي للرسائل:", {
      chat_id: chatId, message_id: msgId, reply_markup: buildAutoDeleteMenu(btnId),
    });
    return;
  }

  // ── Fixed button: add sub-button ────────────────────────────────────────
  if (data.startsWith("btn:add_sub:")) {
    const parentId = parseInt(data.slice(12)!);
    setState(adminId, { type: "button_wait_sub_label", parentId });
    await bot.editMessageText("➕ أرسل نص (اسم) الزر الفرعي الجديد:", {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: `btn:manage:${parentId}` }]] },
    });
    return;
  }
  if (data.startsWith("btn:sub_list:")) {
    await showSubButtonsList(bot, chatId, msgId, parseInt(data.slice(13)!));
    return;
  }

  // ── Fixed button: auto-delete presets ────────────────────────────────────
  if (data.startsWith("btn:autodel:")) {
    const parts = data.split(":");
    const btnId = parseInt(parts[2]!);
    const val = parts[3]!;
    if (val === "custom") {
      setState(adminId, { type: "button_set_autodelete", buttonId: btnId });
      await bot.editMessageText("⏱️ أرسل المدة بالثواني (مثل: 120 = دقيقتان):", {
        chat_id: chatId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: `btn:manage:${btnId}` }]] },
      });
    } else {
      const secs = parseInt(val);
      await db.update(fixedButtonsTable).set({ autoDeleteSeconds: secs === 0 ? null : secs }).where(eq(fixedButtonsTable.id, btnId));
      await showButtonManage(bot, chatId, msgId, btnId);
    }
    return;
  }

  if (data.startsWith("btn:setrow:")) {
    const btnId = parseInt(data.slice(11)!);
    setState(adminId, { type: "button_set_row", buttonId: btnId });
    const allBtns = await db.select().from(fixedButtonsTable).orderBy(asc(fixedButtonsTable.rowGroup));
    const groups = [...new Set(allBtns.map(b => b.rowGroup))];
    await bot.editMessageText(
      `📐 تعيين الصف للزر\n\nالصفوف الحالية: ${groups.join(", ") || "—"}\nأرسل رقم الصف (أي رقم — الأزرار بنفس الرقم تظهر في صف واحد):`,
      { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: `btn:manage:${btnId}` }]] } }
    );
    return;
  }
  if (data.startsWith("btn:addmsg:")) {
    const btnId = parseInt(data.slice(11)!);
    setState(adminId, { type: "button_msg_wait_content", buttonId: btnId });
    await bot.editMessageText(
      "📝 أرسل الرسالة مباشرة الآن\n\nسيتعرف البوت تلقائياً على نوع المحتوى (نص، صورة، فيديو، صوت، ملف، GIF أو ألبوم).",
      {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: `btn:manage:${btnId}` }]] },
      },
    );
    return;
  }
  if (data.startsWith("btn:msgs:")) { await showButtonMessages(bot, chatId, msgId, parseInt(data.slice(9)!)); return; }

  // ── Custom commands ─────────────────────────────────────────────────────
  if (data === "cmdadmin:add") {
    setState(adminId, { type: "command_wait_name" });
    await bot.editMessageText(
      "⌨️ أرسل اسم الأمر الجديد\n\nمثال: /help أو help\n\nيمكن لأزرار الرسائل الانتقال إلى هذا الأمر عبر الصيغة:\nنص الزر = command:help",
      { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: "menu:commands" }]] } },
    );
    return;
  }
  if (data.startsWith("cmdadmin:manage:")) { await showCommandManage(bot, chatId, msgId, parseInt(data.split(":")[2] ?? "", 10)); return; }
  if (data.startsWith("cmdadmin:toggle:")) {
    const commandId = parseInt(data.split(":")[2] ?? "", 10);
    const [command] = await db.select().from(customCommandsTable).where(eq(customCommandsTable.id, commandId));
    if (command) await db.update(customCommandsTable).set({ isActive: !command.isActive }).where(eq(customCommandsTable.id, commandId));
    await showCommandManage(bot, chatId, msgId, commandId);
    return;
  }
  if (data.startsWith("cmdadmin:delete:")) {
    await db.delete(customCommandsTable).where(eq(customCommandsTable.id, parseInt(data.split(":")[2] ?? "", 10)));
    await showCommandsList(bot, chatId, msgId);
    return;
  }
  if (data.startsWith("cmdadmin:addmsg:")) {
    const commandId = parseInt(data.split(":")[2] ?? "", 10);
    setState(adminId, { type: "command_msg_wait_content", commandId });
    await bot.editMessageText("📝 أرسل الرد مباشرة الآن.\n\nيمكن أن يكون نصاً أو صورة أو فيديو أو ملفاً أو ألبوماً، وسيتم الحفاظ على التنسيق.", {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: `cmdadmin:manage:${commandId}` }]] },
    });
    return;
  }
  if (data.startsWith("cmdadmin:skip_inline:")) {
    const commandId = parseInt(data.split(":")[2] ?? "", 10);
    const state = getState(adminId);
    if (state.type === "command_msg_wait_inline" && state.commandId === commandId) {
      await insertCommandMessage(state.commandId, state.msgType, state.content, state.caption, state.contentEntities, state.captionEntities, state.forwardData, null);
      resetState(adminId);
      await bot.editMessageText("✅ تمت إضافة الرد بدون أزرار.", {
        chat_id: chatId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: "📝 إضافة رد آخر", callback_data: `cmdadmin:addmsg:${commandId}` }], [{ text: "↩️ إدارة الأمر", callback_data: `cmdadmin:manage:${commandId}` }]] },
      });
    }
    return;
  }
  if (data.startsWith("cmdadmin:msgs:")) { await showCommandMessages(bot, chatId, msgId, parseInt(data.split(":")[2] ?? "", 10)); return; }
  if (data.startsWith("cmdmsg:preview:")) {
    const messageId = parseInt(data.split(":")[2] ?? "", 10);
    const [message] = await db.select().from(commandMessagesTable).where(eq(commandMessagesTable.id, messageId));
    if (message) await sendBotMessage(chatId, message.messageType, message.content, message.caption ?? undefined, message.inlineButtons ?? undefined, false, {
      contentEntities: message.contentEntities, captionEntities: message.captionEntities, forwardData: message.forwardData,
      interactiveCommandId: message.commandId,
    });
    return;
  }
  if (data.startsWith("cmdmsg:edit:")) {
    const parts = data.split(":");
    const messageId = parseInt(parts[2] ?? "", 10);
    const commandId = parseInt(parts[3] ?? "", 10);
    const [message] = await db.select().from(commandMessagesTable).where(and(eq(commandMessagesTable.id, messageId), eq(commandMessagesTable.commandId, commandId)));
    if (message) {
      setState(adminId, { type: "command_msg_edit_wait_content", commandId, msgId: messageId });
      await bot.editMessageText(`✏️ تعديل رد ${getTypeLabel(message.messageType)}\n\nأرسل المحتوى الجديد:`, {
        chat_id: chatId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: "↩️ الردود", callback_data: `cmdadmin:msgs:${commandId}` }]] },
      });
    }
    return;
  }
  if (data.startsWith("cmdmsg:up:") || data.startsWith("cmdmsg:down:")) {
    const parts = data.split(":");
    const messageId = parseInt(parts[2] ?? "", 10);
    const commandId = parseInt(parts[3] ?? "", 10);
    await reorderCommandMessage(messageId, commandId, data.startsWith("cmdmsg:up:") ? -1 : 1);
    await showCommandMessages(bot, chatId, msgId, commandId);
    return;
  }
  if (data.startsWith("cmdmsg:del:")) {
    const parts = data.split(":");
    await db.delete(commandMessagesTable).where(eq(commandMessagesTable.id, parseInt(parts[2] ?? "", 10)));
    await showCommandMessages(bot, chatId, msgId, parseInt(parts[3] ?? "", 10));
    return;
  }

  if (data.startsWith("btedit:")) {
    const [, btnId, mId, msgType] = data.split(":");
    const buttonId = parseInt(btnId!);
    const dbMsgId = parseInt(mId!);
    if (msgType === "media_group") {
      setState(adminId, { type: "button_msg_edit_wait_media_group", buttonId, msgId: dbMsgId });
      await bot.editMessageText("📸 أرسل الألبوم الجديد (صور و/أو فيديوهات معاً في رسالة واحدة):", {
        chat_id: chatId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: `btn:msgs:${btnId}` }]] },
      });
      return;
    }
    setState(adminId, { type: "button_msg_edit_wait_content", buttonId, msgId: dbMsgId });
    await bot.editMessageText("✏️ أرسل المحتوى الجديد الآن، وسيكتشف البوت نوعه وتنسيقه تلقائياً:", {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: `btn:msgs:${btnId}` }]] },
    });
    return;
  }

  // Button message skip caption/inline (add flow)
  if (data.startsWith("btnmsg:skip_caption:")) {
    const btnId = parseInt(data.slice(20)!);
    const state = getState(adminId);
    if (state.type === "button_msg_wait_caption") {
      setState(adminId, { type: "button_msg_wait_inline", buttonId: btnId, msgType: state.msgType, content: state.content });
      await bot.editMessageText("أرسل أزرار شفافة أو:", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "⏭️ بدون أزرار", callback_data: `btnmsg:skip_inline:${btnId}` }], [{ text: "↩️ رجوع", callback_data: `btn:manage:${btnId}` }]] } });
    }
    return;
  }
  if (data.startsWith("btnmsg:skip_inline:")) {
    const btnId = parseInt(data.slice(19)!);
    const state = getState(adminId);
    if (state.type === "button_msg_wait_inline") {
      const msgs = await db.select({ count: count() }).from(buttonMessagesTable).where(eq(buttonMessagesTable.buttonId, btnId));
      await db.insert(buttonMessagesTable).values({ buttonId: btnId, messageType: state.msgType, content: state.content, caption: state.caption ?? null, inlineButtons: null, orderIndex: Number(msgs[0]?.count ?? 0) });
      resetState(adminId);
      await bot.editMessageText("✅ تم إضافة الرسالة!", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "↩️ إدارة الزر", callback_data: `btn:manage:${btnId}` }]] } });
    }
    return;
  }

  // Button message edit skip caption/inline
  if (data.startsWith("btnmsg:edit_skip_caption:")) {
    const [, , , btnId, mId] = data.split(":");
    const state = getState(adminId);
    if (state.type === "button_msg_edit_wait_caption") {
      setState(adminId, { type: "button_msg_edit_wait_inline", buttonId: parseInt(btnId!), msgId: parseInt(mId!), msgType: state.msgType, content: state.content });
      await bot.editMessageText("أرسل أزرار شفافة أو:", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "⏭️ بدون أزرار", callback_data: `btnmsg:edit_skip_inline:${btnId}:${mId}` }], [{ text: "↩️ رجوع", callback_data: `btn:msgs:${btnId}` }]] } });
    }
    return;
  }
  if (data.startsWith("btnmsg:edit_skip_inline:")) {
    const parts = data.split(":");
    const btnId = parseInt(parts[2]!);
    const mId = parseInt(parts[3]!);
    const state = getState(adminId);
    if (state.type === "button_msg_edit_wait_inline") {
      await db.update(buttonMessagesTable).set({ messageType: state.msgType, content: state.content, caption: state.caption ?? null, inlineButtons: null }).where(eq(buttonMessagesTable.id, mId));
      resetState(adminId);
      await bot.editMessageText("✅ تم التعديل!", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "↩️ رسائل الزر", callback_data: `btn:msgs:${btnId}` }]] } });
    }
    return;
  }

  // Button message reorder
  if (data.startsWith("btnmsg:up:")) {
    const [, , mId, btnId] = data.split(":");
    await reorderMsg(parseInt(mId!), parseInt(btnId!), -1);
    await showButtonMessages(bot, chatId, msgId, parseInt(btnId!));
    return;
  }
  if (data.startsWith("btnmsg:down:")) {
    const [, , mId, btnId] = data.split(":");
    await reorderMsg(parseInt(mId!), parseInt(btnId!), 1);
    await showButtonMessages(bot, chatId, msgId, parseInt(btnId!));
    return;
  }

  // Button message preview
  if (data.startsWith("btnmsg:preview:")) {
    const [, , mId] = data.split(":");
    const [bm] = await db.select().from(buttonMessagesTable).where(eq(buttonMessagesTable.id, parseInt(mId!)));
    if (bm) {
      await bot.answerCallbackQuery(query.id, { text: "📤 إرسال المعاينة..." });
      await sendBotMessage(chatId, bm.messageType, bm.content, bm.caption ?? undefined, bm.inlineButtons ?? undefined, false, {
        contentEntities: bm.contentEntities,
        captionEntities: bm.captionEntities,
        forwardData: bm.forwardData,
      });
    }
    return;
  }

  // Button message delete confirmation
  if (data.startsWith("btnmsg:del_confirm:")) {
    const [, , , mId, btnId] = data.split(":");
    const [bm] = await db.select().from(buttonMessagesTable).where(eq(buttonMessagesTable.id, parseInt(mId!)));
    if (bm) {
      await bot.editMessageText(
        `⚠️ تأكيد الحذف\n\nهل تريد حذف رسالة "${getTypeLabel(bm.messageType)}" من هذا الزر؟`,
        {
          chat_id: chatId, message_id: msgId,
          reply_markup: { inline_keyboard: [[{ text: "✅ نعم، احذف", callback_data: `btnmsg:del_yes:${mId}:${btnId}` }, { text: "❌ إلغاء", callback_data: `btn:msgs:${btnId}` }]] },
        }
      );
    }
    return;
  }
  if (data.startsWith("btnmsg:del_yes:")) {
    const parts = data.split(":");
    const mId = parseInt(parts[2]!);
    const btnId = parseInt(parts[3]!);
    const [bm] = await db.select().from(buttonMessagesTable).where(eq(buttonMessagesTable.id, mId));
    if (bm) await db.delete(buttonMessagesTable).where(eq(buttonMessagesTable.id, mId));
    await showButtonMessages(bot, chatId, msgId, btnId);
    return;
  }

  // ── Channels ───────────────────────────────────────────────────────────
  if (data === "ch:add") {
    setState(adminId, { type: "channel_wait_id" });
    await bot.editMessageText("📡 أرسل معرف القناة:\n• @username للعامة\n• -100xxxxxxxxx للخاصة\n\n⚠️ يجب أن يكون البوت مشرفاً", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: "menu:channels" }]] } });
    return;
  }
  if (data.startsWith("ch:toggle:")) { const chId = parseInt(data.slice(10)!); const [ch] = await db.select().from(channelsTable).where(eq(channelsTable.id, chId)); if (ch) await db.update(channelsTable).set({ isActive: !ch.isActive }).where(eq(channelsTable.id, chId)); await showChannelsList(bot, chatId, msgId); return; }
  if (data.startsWith("ch:delete:")) { await db.delete(channelsTable).where(eq(channelsTable.id, parseInt(data.slice(10)!))); await showChannelsList(bot, chatId, msgId); return; }
  if (data === "ch:skip_url") {
    const state = getState(adminId);
    if (state.type === "channel_wait_url") {
      const username = state.channelId.startsWith("@") ? state.channelId.slice(1) : undefined;
      const url = username ? `https://t.me/${username}` : state.channelId;
      await db.insert(channelsTable).values({ channelId: state.channelId, channelName: state.channelName, channelUsername: username ?? null, channelUrl: url, isActive: true }).onConflictDoNothing();
      resetState(adminId);
      await bot.editMessageText(`✅ تم إضافة "${state.channelName}"!`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "↩️ القنوات", callback_data: "menu:channels" }]] } });
    }
    return;
  }

  // ── Settings ───────────────────────────────────────────────────────────
  if (data === "menu:settings") { await showSettingsMenu(bot, chatId, msgId); return; }
  if (data === "setting:toggle_content_protection") {
    const settings = await getSettings();
    await saveSetting("contentProtection", settings.contentProtection ? "false" : "true");
    await showSettingsMenu(bot, chatId, msgId);
    return;
  }
  if (data.startsWith("setting:restore:")) {
    const key = data.slice(16) as keyof typeof DEFAULTS;
    if (key in DEFAULTS) await saveSetting(key, String(DEFAULTS[key]));
    await showSettingsMenu(bot, chatId, msgId);
    return;
  }
  if (data.startsWith("setting:")) {
    const key = data.slice(8)!;
    if (!(key in settingMeta)) return;
    const settings = await getSettings();
    const meta = settingMeta[key]!;
    const currentVal = (settings as unknown as Record<string, string>)[key] ?? meta.defaultVal;
    setState(adminId, { type: "setting_wait_value", key, label: meta.label });
    await bot.editMessageText(
      `✏️ ${meta.label}\n\n📌 القيمة الحالية:\n${currentVal || "(فارغ)"}\n\nأرسل القيمة الجديدة:`,
      {
        chat_id: chatId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: `🔄 استعادة الافتراضي`, callback_data: `setting:restore:${key}` }], [{ text: "↩️ رجوع", callback_data: "menu:settings" }]] },
      }
    );
    return;
  }
}

// ── Text handler ───────────────────────────────────────────────────────────

type DetectedContent = {
  messageType: string;
  content: string;
  caption?: string;
  contentEntities?: string;
  captionEntities?: string;
  forwardData?: string;
  isMedia?: boolean;
};

function jsonValue(value: unknown): string {
  return JSON.stringify(value ?? []);
}

function getForwardData(msg: Message): string | undefined {
  const modernOrigin = (msg as Message & { forward_origin?: {
    type?: string;
    chat?: { id?: number | string };
    message_id?: number;
  } }).forward_origin;
  if (modernOrigin?.chat?.id !== undefined && modernOrigin.message_id !== undefined) {
    return JSON.stringify({
      fromChatId: modernOrigin.chat.id,
      messageIds: [modernOrigin.message_id],
    });
  }

  const legacy = msg as Message & {
    forward_from_chat?: { id?: number | string };
    forward_from_message_id?: number;
  };
  if (legacy.forward_from_chat?.id !== undefined && legacy.forward_from_message_id !== undefined) {
    return JSON.stringify({
      fromChatId: legacy.forward_from_chat.id,
      messageIds: [legacy.forward_from_message_id],
    });
  }

  // User-origin forwards and protected content do not expose a source chat.
  // Forwarding the received admin message preserves Telegram's original
  // forward header while still working when the source is unavailable.
  if (modernOrigin || msg.is_automatic_forward || legacy.forward_from_chat ||
      (msg as Message & { forward_from?: unknown }).forward_from) {
    return JSON.stringify({ fromChatId: msg.chat.id, messageIds: [msg.message_id] });
  }
  return undefined;
}

/** Detect the content type from the Telegram message itself. */
function detectContent(msg: Message): DetectedContent | undefined {
  const forwardData = getForwardData(msg);
  if (forwardData) {
    return {
      messageType: "forward",
      content: "",
      caption: msg.caption,
      contentEntities: jsonValue(msg.entities),
      captionEntities: jsonValue(msg.caption_entities),
      forwardData,
      isMedia: !msg.text,
    };
  }
  if (msg.text) {
    return {
      messageType: forwardData ? "forward" : "text",
      content: msg.text,
      contentEntities: jsonValue(msg.entities),
      isMedia: false,
    };
  }
  if (msg.photo?.length) {
    return {
      messageType: forwardData ? "forward" : "photo",
      content: msg.photo[msg.photo.length - 1]!.file_id,
      caption: msg.caption,
      captionEntities: jsonValue(msg.caption_entities),
      isMedia: true,
    };
  }
  if (msg.video) return { messageType: "video", content: msg.video.file_id, caption: msg.caption, captionEntities: jsonValue(msg.caption_entities), isMedia: true };
  if (msg.audio) return { messageType: "audio", content: msg.audio.file_id, caption: msg.caption, captionEntities: jsonValue(msg.caption_entities), isMedia: true };
  if (msg.document) return { messageType: "document", content: msg.document.file_id, caption: msg.caption, captionEntities: jsonValue(msg.caption_entities), isMedia: true };
  if (msg.animation) return { messageType: "animation", content: msg.animation.file_id, caption: msg.caption, captionEntities: jsonValue(msg.caption_entities), isMedia: true };
  if (msg.voice) return { messageType: "voice", content: msg.voice.file_id, caption: msg.caption, captionEntities: jsonValue(msg.caption_entities), isMedia: true };
  if (msg.video_note) return { messageType: "video_note", content: msg.video_note.file_id, isMedia: true };
  if (msg.sticker) return { messageType: "sticker", content: msg.sticker.file_id, isMedia: true };
  if (msg.location) return { messageType: "location", content: JSON.stringify(msg.location), isMedia: true };
  if (msg.venue) return { messageType: "venue", content: JSON.stringify(msg.venue), isMedia: true };
  if (msg.contact) return { messageType: "contact", content: JSON.stringify(msg.contact), isMedia: true };
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
      isMedia: true,
    };
  }
  if (msg.dice) return { messageType: "dice", content: JSON.stringify({ emoji: msg.dice.emoji }), isMedia: true };
  return undefined;
}

export async function handleAdminText(bot: TelegramBot, msg: Message, adminId: number): Promise<boolean> {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const state = getState(adminId);

  if (state.type === "idle") return false;

  // Broadcast flows
  if (state.type === "broadcast_wait_content") {
    const detected = detectContent(msg);
    if (!detected) { await bot.sendMessage(chatId, "❌ لم يُتعرف على نوع الرسالة، أرسل نصاً أو وسائط مدعومة وحاول مجدداً."); return true; }
    setState(adminId, {
      type: "broadcast_confirm",
      msgType: detected.messageType,
      content: detected.content,
      caption: detected.caption,
      contentEntities: detected.contentEntities,
      captionEntities: detected.captionEntities,
      forwardData: detected.forwardData,
    });
    await showBroadcastConfirm(bot, chatId, undefined, detected.messageType, detected.content, detected.caption);
    return true;
  }
  if (state.type === "broadcast_wait_caption") {
    setState(adminId, { type: "broadcast_wait_inline", msgType: state.msgType, content: state.content, caption: text, contentEntities: state.contentEntities, captionEntities: state.captionEntities, forwardData: state.forwardData });
    await bot.sendMessage(chatId, "هل تريد أزرار شفافة؟ أرسلها أو:", { reply_markup: { inline_keyboard: [[{ text: "⏭️ بدون أزرار", callback_data: "broadcast:skip_inline" }]] } });
    return true;
  }
  if (state.type === "broadcast_wait_inline") {
    setState(adminId, { type: "broadcast_confirm", msgType: state.msgType, content: state.content, caption: state.caption, contentEntities: state.contentEntities, captionEntities: state.captionEntities, forwardData: state.forwardData, inlineButtons: text });
    await showBroadcastConfirm(bot, chatId, undefined, state.msgType, state.content, state.caption, text);
    return true;
  }

  // User ban/unban
  if (state.type === "user_ban_wait") {
    const tid = text.trim();
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, tid));
    resetState(adminId);
    if (!user) { await bot.sendMessage(chatId, `❌ لم يُعثر على مستخدم بالمعرف: ${tid}`); return true; }
    await db.update(usersTable).set({ isBanned: true }).where(eq(usersTable.telegramId, tid));
    await bot.sendMessage(chatId, `✅ تم حظر ${user.firstName ?? ""} [${tid}]`, { reply_markup: { inline_keyboard: [[{ text: "↩️ المستخدمون", callback_data: "menu:users" }]] } });
    return true;
  }
  if (state.type === "user_unban_wait") {
    const tid = text.trim();
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, tid));
    resetState(adminId);
    if (!user) { await bot.sendMessage(chatId, `❌ لم يُعثر على مستخدم بالمعرف: ${tid}`); return true; }
    await db.update(usersTable).set({ isBanned: false }).where(eq(usersTable.telegramId, tid));
    await bot.sendMessage(chatId, `✅ تم رفع الحظر عن ${user.firstName ?? ""} [${tid}]`, { reply_markup: { inline_keyboard: [[{ text: "↩️ المستخدمون", callback_data: "menu:users" }]] } });
    return true;
  }

  // Button creation (root)
  if (state.type === "button_wait_label") {
    const label = text.trim();
    const existing = await db.select({ count: count() }).from(fixedButtonsTable);
    const orderIdx = Number(existing[0]?.count ?? 0);
    const token = generateToken();
    const [btn] = await db.insert(fixedButtonsTable).values({ label, token, rowGroup: orderIdx, orderIndex: orderIdx, isActive: true }).returning();
    resetState(adminId);
    await bot.sendMessage(chatId, `✅ تم إنشاء الزر "${label}"!\nأضف رسائل له:`, { reply_markup: { inline_keyboard: [[{ text: "📝 إضافة رسالة", callback_data: `btn:manage:${btn!.id}` }], [{ text: "↩️ قائمة الأزرار", callback_data: "menu:buttons" }]] } });
    return true;
  }

  if (state.type === "command_wait_name") {
    const command = text.trim().replace(/^\/+/, "").split("@")[0]?.toLowerCase() ?? "";
    if (!/^[a-z0-9_]{1,32}$/.test(command) || ["start", "menu"].includes(command)) {
      await bot.sendMessage(chatId, "❌ اسم غير صالح. استخدم أحرفاً إنجليزية وأرقاماً وشرطة سفلية فقط، مثل: help");
      return true;
    }
    const [existing] = await db.select().from(customCommandsTable).where(eq(customCommandsTable.command, command));
    if (existing) { await bot.sendMessage(chatId, "❌ هذا الأمر موجود مسبقاً."); return true; }
    const [created] = await db.insert(customCommandsTable).values({ command, title: `/${command}`, isActive: true }).returning();
    resetState(adminId);
    await bot.sendMessage(chatId, `✅ تم إنشاء /${command}.\nأضف الآن الردود بالترتيب الذي تريده:`, {
      reply_markup: { inline_keyboard: [[{ text: "📝 إضافة رد", callback_data: `cmdadmin:addmsg:${created!.id}` }], [{ text: "↩️ قائمة الأوامر", callback_data: "menu:commands" }]] },
    });
    return true;
  }

  if (state.type === "command_msg_wait_content") {
    const detected = detectContent(msg);
    if (!detected) { await bot.sendMessage(chatId, "❌ أرسل نصاً أو نوع وسائط مدعوماً."); return true; }
    setState(adminId, {
      type: "command_msg_wait_inline",
      commandId: state.commandId,
      msgType: detected.messageType,
      content: detected.content,
      caption: detected.caption,
      contentEntities: detected.contentEntities,
      captionEntities: detected.captionEntities,
      forwardData: detected.forwardData,
    });
    await bot.sendMessage(chatId, "أرسل الأزرار الشفافة بصيغة:\nنص الزر = رابط\n\nلربط الزر بأمر آخر:\nنص الزر = command:اسم_الأمر\n\nللرجوع: نص الزر = back\nللرئيسية: نص الزر = home", {
      reply_markup: { inline_keyboard: [[{ text: "⏭️ بدون أزرار", callback_data: `cmdadmin:skip_inline:${state.commandId}` }], [{ text: "↩️ إدارة الأمر", callback_data: `cmdadmin:manage:${state.commandId}` }]] },
    });
    return true;
  }
  if (state.type === "command_msg_wait_inline") {
    await insertCommandMessage(state.commandId, state.msgType, state.content, state.caption, state.contentEntities, state.captionEntities, state.forwardData, text);
    resetState(adminId);
    await bot.sendMessage(chatId, "✅ تمت إضافة الرد.", {
      reply_markup: { inline_keyboard: [[{ text: "📝 إضافة رد آخر", callback_data: `cmdadmin:addmsg:${state.commandId}` }], [{ text: "↩️ إدارة الأمر", callback_data: `cmdadmin:manage:${state.commandId}` }]] },
    });
    return true;
  }
  if (state.type === "command_msg_edit_wait_content") {
    const detected = detectContent(msg);
    if (!detected) { await bot.sendMessage(chatId, "❌ أرسل نصاً أو نوع وسائط مدعوماً."); return true; }
    await db.update(commandMessagesTable).set({
      messageType: detected.messageType,
      content: detected.content,
      caption: detected.caption ?? null,
      contentEntities: detected.contentEntities ?? null,
      captionEntities: detected.captionEntities ?? null,
      forwardData: detected.forwardData ?? null,
    }).where(and(eq(commandMessagesTable.id, state.msgId), eq(commandMessagesTable.commandId, state.commandId)));
    resetState(adminId);
    await bot.sendMessage(chatId, "✅ تم تعديل الرد.", {
      reply_markup: { inline_keyboard: [[{ text: "↩️ ردود الأمر", callback_data: `cmdadmin:msgs:${state.commandId}` }]] },
    });
    return true;
  }

  // Sub-button creation
  if (state.type === "button_wait_sub_label") {
    const label = text.trim();
    const siblings = await db.select({ count: count() }).from(fixedButtonsTable).where(eq(fixedButtonsTable.parentId, state.parentId));
    const orderIdx = Number(siblings[0]?.count ?? 0);
    const token = generateToken();
    const [btn] = await db.insert(fixedButtonsTable).values({ label, token, rowGroup: orderIdx, orderIndex: orderIdx, isActive: true, parentId: state.parentId }).returning();
    resetState(adminId);
    await bot.sendMessage(chatId, `✅ تم إنشاء الزر الفرعي "${label}"!`, { reply_markup: { inline_keyboard: [[{ text: "📝 إضافة رسالة", callback_data: `btn:manage:${btn!.id}` }], [{ text: "↩️ الزر الأب", callback_data: `btn:manage:${state.parentId}` }]] } });
    return true;
  }

  // Auto-delete custom
  if (state.type === "button_set_autodelete") {
    const secs = parseInt(text.trim());
    if (isNaN(secs) || secs < 0) { await bot.sendMessage(chatId, "❌ أرسل رقماً صحيحاً (بالثواني)."); return true; }
    await db.update(fixedButtonsTable).set({ autoDeleteSeconds: secs === 0 ? null : secs }).where(eq(fixedButtonsTable.id, state.buttonId));
    resetState(adminId);
    await bot.sendMessage(chatId, `✅ تم ضبط الحذف التلقائي: ${secs === 0 ? "معطّل" : `${secs} ثانية`}`, { reply_markup: { inline_keyboard: [[{ text: "↩️ إدارة الزر", callback_data: `btn:manage:${state.buttonId}` }]] } });
    return true;
  }

  // Button row group
  if (state.type === "button_set_row") {
    const rowGroup = parseInt(text.trim());
    if (isNaN(rowGroup)) { await bot.sendMessage(chatId, "❌ أرسل رقماً صحيحاً."); return true; }
    await db.update(fixedButtonsTable).set({ rowGroup }).where(eq(fixedButtonsTable.id, state.buttonId));
    resetState(adminId);
    await bot.sendMessage(chatId, `✅ تم تعيين الصف ${rowGroup} للزر.`, { reply_markup: { inline_keyboard: [[{ text: "↩️ إدارة الزر", callback_data: `btn:manage:${state.buttonId}` }]] } });
    return true;
  }

  // Button message ADD flow
  if (state.type === "button_msg_wait_content") {
    const detected = detectContent(msg);
    if (!detected) {
      await bot.sendMessage(chatId, "❌ لم يُتعرف على نوع الرسالة، أرسل نصاً أو وسائط مدعومة وحاول مجدداً.");
      return true;
    }
    const msgs = await db.select({ count: count() }).from(buttonMessagesTable).where(eq(buttonMessagesTable.buttonId, state.buttonId));
    await db.insert(buttonMessagesTable).values({
      buttonId: state.buttonId,
      messageType: detected.messageType,
      content: detected.content,
      caption: detected.caption ?? null,
      contentEntities: detected.contentEntities ?? null,
      captionEntities: detected.captionEntities ?? null,
      forwardData: detected.forwardData ?? null,
      inlineButtons: null,
      orderIndex: Number(msgs[0]?.count ?? 0),
    });
    resetState(adminId);
    await bot.sendMessage(chatId, "✅ تم إضافة الرسالة مباشرة مع الحفاظ على نوعها وتنسيقها.", {
      reply_markup: { inline_keyboard: [[{ text: "↩️ إدارة الزر", callback_data: `btn:manage:${state.buttonId}` }]] },
    });
    return true;
  }
  if (state.type === "button_msg_wait_caption") {
    setState(adminId, { type: "button_msg_wait_inline", buttonId: state.buttonId, msgType: state.msgType, content: state.content, caption: text, contentEntities: state.contentEntities, captionEntities: state.captionEntities, forwardData: state.forwardData });
    await bot.sendMessage(chatId, "أرسل أزرار شفافة أو:", { reply_markup: { inline_keyboard: [[{ text: "⏭️ بدون أزرار", callback_data: `btnmsg:skip_inline:${state.buttonId}` }]] } });
    return true;
  }
  if (state.type === "button_msg_wait_inline") {
    const msgs = await db.select({ count: count() }).from(buttonMessagesTable).where(eq(buttonMessagesTable.buttonId, state.buttonId));
    await db.insert(buttonMessagesTable).values({ buttonId: state.buttonId, messageType: state.msgType, content: state.content, caption: state.caption ?? null, contentEntities: state.contentEntities ?? null, captionEntities: state.captionEntities ?? null, forwardData: state.forwardData ?? null, inlineButtons: text, orderIndex: Number(msgs[0]?.count ?? 0) });
    resetState(adminId);
    await bot.sendMessage(chatId, "✅ تم إضافة الرسالة!", { reply_markup: { inline_keyboard: [[{ text: "↩️ إدارة الزر", callback_data: `btn:manage:${state.buttonId}` }]] } });
    return true;
  }

  // Button message EDIT flow
  if (state.type === "button_msg_edit_wait_content") {
    const detected = detectContent(msg);
    if (!detected) {
      await bot.sendMessage(chatId, "❌ لم يُتعرف على نوع الرسالة، أرسل نصاً أو وسائط مدعومة وحاول مجدداً.");
      return true;
    }
    await db.update(buttonMessagesTable).set({
      messageType: detected.messageType,
      content: detected.content,
      caption: detected.caption ?? null,
      contentEntities: detected.contentEntities ?? null,
      captionEntities: detected.captionEntities ?? null,
      forwardData: detected.forwardData ?? null,
    }).where(eq(buttonMessagesTable.id, state.msgId));
    resetState(adminId);
    await bot.sendMessage(chatId, "✅ تم تعديل الرسالة مع الحفاظ على نوعها وتنسيقها.", {
      reply_markup: { inline_keyboard: [[{ text: "↩️ رسائل الزر", callback_data: `btn:msgs:${state.buttonId}` }]] },
    });
    return true;
  }
  if (state.type === "button_msg_edit_wait_caption") {
    setState(adminId, { type: "button_msg_edit_wait_inline", buttonId: state.buttonId, msgId: state.msgId, msgType: state.msgType, content: state.content, caption: text });
    await bot.sendMessage(chatId, "أرسل أزرار شفافة أو:", { reply_markup: { inline_keyboard: [[{ text: "⏭️ بدون أزرار", callback_data: `btnmsg:edit_skip_inline:${state.buttonId}:${state.msgId}` }]] } });
    return true;
  }
  if (state.type === "button_msg_edit_wait_inline") {
    const { buttonId, msgId: mId, msgType, content, caption } = state;
    await db.update(buttonMessagesTable).set({ messageType: msgType, content, caption: caption ?? null, inlineButtons: text }).where(eq(buttonMessagesTable.id, mId));
    resetState(adminId);
    await bot.sendMessage(chatId, "✅ تم التعديل!", { reply_markup: { inline_keyboard: [[{ text: "↩️ رسائل الزر", callback_data: `btn:msgs:${buttonId}` }]] } });
    return true;
  }

  // Channel flows
  if (state.type === "channel_wait_id") {
    setState(adminId, { type: "channel_wait_name", channelId: text.trim() });
    await bot.sendMessage(chatId, "أرسل اسم القناة للمستخدمين:", { reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: "menu:channels" }]] } });
    return true;
  }
  if (state.type === "channel_wait_name") {
    setState(adminId, { type: "channel_wait_url", channelId: state.channelId, channelName: text });
    await bot.sendMessage(chatId, "أرسل رابط القناة أو:", { reply_markup: { inline_keyboard: [[{ text: "⏭️ استخدام المعرف تلقائياً", callback_data: "ch:skip_url" }]] } });
    return true;
  }
  if (state.type === "channel_wait_url") {
    const url = text.startsWith("http") ? text : `https://t.me/${text.replace("@", "")}`;
    const username = state.channelId.startsWith("@") ? state.channelId.slice(1) : undefined;
    await db.insert(channelsTable).values({ channelId: state.channelId, channelName: state.channelName, channelUsername: username ?? null, channelUrl: url, isActive: true }).onConflictDoNothing();
    resetState(adminId);
    await bot.sendMessage(chatId, `✅ تم إضافة "${state.channelName}"!`, { reply_markup: { inline_keyboard: [[{ text: "↩️ القنوات", callback_data: "menu:channels" }]] } });
    return true;
  }

  // Settings flow
  if (state.type === "setting_wait_value") {
    const { key } = state;
    await saveSetting(key as Parameters<typeof saveSetting>[0], text);
    if (key === "startMessage" || key === "subscriptionMessage" || key === "fixedButtonsMessage") {
      await saveSetting(`${key}Entities` as Parameters<typeof saveSetting>[0], jsonValue(msg.entities));
    }
    resetState(adminId);
    await bot.sendMessage(chatId, `✅ تم تحديث "${settingMeta[key]?.label ?? key}"!`, { reply_markup: { inline_keyboard: [[{ text: "↩️ الإعدادات", callback_data: "menu:settings" }]] } });
    return true;
  }

  return false;
}

// ── Display helpers ────────────────────────────────────────────────────────
async function showMainMenu(bot: TelegramBot, chatId: number, msgId: number) {
  await bot.editMessageText("🎛️ لوحة التحكم الرئيسية", { chat_id: chatId, message_id: msgId, reply_markup: MAIN_MENU }).catch(() => {});
}

async function showStats(bot: TelegramBot, chatId: number, msgId: number) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [total, banned, blocked, todayJoined, bcastCount] = await Promise.all([
    db.select({ count: count() }).from(usersTable),
    db.select({ count: count() }).from(usersTable).where(eq(usersTable.isBanned, true)),
    db.select({ count: count() }).from(usersTable).where(eq(usersTable.isBlockedBot, true)),
    db.select({ count: count() }).from(usersTable).where(gte(usersTable.joinedAt, today)),
    db.select({ count: count() }).from(broadcastsTable),
  ]);
  await bot.editMessageText(
    `📊 إحصائيات البوت\n\n👥 الإجمالي: ${total[0]?.count ?? 0}\n✅ انضموا اليوم: ${todayJoined[0]?.count ?? 0}\n⛔ محظورون: ${banned[0]?.count ?? 0}\n🚫 أوقفوا البوت: ${blocked[0]?.count ?? 0}\n📢 إذاعات: ${bcastCount[0]?.count ?? 0}`,
    { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔄 تحديث", callback_data: "menu:stats" }], [BACK_MAIN]] } }
  ).catch(() => {});
}

async function showUsersMenu(bot: TelegramBot, chatId: number, msgId: number) {
  const totalRes = await db.select({ count: count() }).from(usersTable);
  const bannedRes = await db.select({ count: count() }).from(usersTable).where(eq(usersTable.isBanned, true));
  await bot.editMessageText(
    `👥 المستخدمون\n\n📊 الإجمالي: ${totalRes[0]?.count ?? 0}\n⛔ المحظورون: ${bannedRes[0]?.count ?? 0}`,
    { chat_id: chatId, message_id: msgId, reply_markup: USERS_MENU }
  ).catch(() => {});
}

async function showUsersList(bot: TelegramBot, chatId: number, msgId: number, page: number, bannedOnly: boolean) {
  const limit = 10;
  const offset = page * limit;
  const prefix = bannedOnly ? "users:banned" : "users:list";
  const rows = await db.select().from(usersTable)
    .where(bannedOnly ? eq(usersTable.isBanned, true) : undefined)
    .orderBy(desc(usersTable.joinedAt)).limit(limit).offset(offset);
  const totalRes = await db.select({ count: count() }).from(usersTable).where(bannedOnly ? eq(usersTable.isBanned, true) : undefined);
  const total = Number(totalRes[0]?.count ?? 0);
  const totalPages = Math.ceil(total / limit) || 1;
  let text = bannedOnly ? `⛔ المحظورون (${total})\n\n` : `👥 المستخدمون (${total})\n\n`;
  for (const u of rows) {
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "—";
    text += `• ${name} | ${u.username ? `@${u.username}` : "—"} | ${u.telegramId}${u.isBanned ? " ⛔" : ""}\n`;
  }
  if (rows.length === 0) text += "لا يوجد مستخدمون.";
  const navRow: InlineKeyboardButton[] = [];
  if (page > 0) navRow.push({ text: "⬅️ السابق", callback_data: `${prefix}:${page - 1}` });
  if (page < totalPages - 1) navRow.push({ text: "التالي ➡️", callback_data: `${prefix}:${page + 1}` });
  const keyboard: InlineKeyboardButton[][] = [];
  if (navRow.length > 0) keyboard.push(navRow);
  keyboard.push([{ text: "↩️ المستخدمون", callback_data: "menu:users" }]);
  await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
}

async function showButtonsList(bot: TelegramBot, chatId: number, msgId: number) {
  // Show root-level buttons only; sub-buttons are shown inside their parent's manage page.
  const buttons = await db.select().from(fixedButtonsTable)
    .where(isNull(fixedButtonsTable.parentId))
    .orderBy(asc(fixedButtonsTable.rowGroup), asc(fixedButtonsTable.orderIndex));
  // Count sub-buttons per parent
  const allSubs = await db.select({ parentId: fixedButtonsTable.parentId, id: fixedButtonsTable.id })
    .from(fixedButtonsTable);
  const subCount: Record<number, number> = {};
  for (const s of allSubs) if (s.parentId) subCount[s.parentId] = (subCount[s.parentId] ?? 0) + 1;

  const rows: InlineKeyboardButton[][] = [[{ text: "➕ إضافة زر جديد", callback_data: "btn:add" }]];
  for (const btn of buttons) {
    const sub = subCount[btn.id] ?? 0;
    const subLabel = sub > 0 ? ` 📂${sub}` : "";
    rows.push([{ text: `${btn.isActive ? "✅" : "❌"} ${btn.label}${subLabel} (صف ${btn.rowGroup})`, callback_data: `btn:manage:${btn.id}` }]);
  }
  rows.push([BACK_MAIN]);
  await bot.editMessageText(`🔘 الأزرار الثابتة (${buttons.length})`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: rows } }).catch(() => {});
}

async function showCommandsList(bot: TelegramBot, chatId: number, msgId: number) {
  const commands = await db.select().from(customCommandsTable).orderBy(asc(customCommandsTable.orderIndex), asc(customCommandsTable.id));
  const rows: InlineKeyboardButton[][] = [[{ text: "➕ إضافة أمر", callback_data: "cmdadmin:add" }]];
  for (const command of commands) {
    rows.push([{ text: `${command.isActive ? "✅" : "❌"} /${command.command}`, callback_data: `cmdadmin:manage:${command.id}` }]);
  }
  rows.push([BACK_MAIN]);
  await bot.editMessageText(`⌨️ الأوامر المخصصة (${commands.length})`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: rows } }).catch(() => {});
}

async function showCommandManage(bot: TelegramBot, chatId: number, msgId: number, commandId: number) {
  const [command] = await db.select().from(customCommandsTable).where(eq(customCommandsTable.id, commandId));
  if (!command) { await showCommandsList(bot, chatId, msgId); return; }
  const [messages] = await db.select({ count: count() }).from(commandMessagesTable).where(eq(commandMessagesTable.commandId, commandId));
  await bot.editMessageText(
    `⌨️ الأمر /${command.command}\nالحالة: ${command.isActive ? "✅ مفعّل" : "❌ معطّل"}\nعدد الردود: ${messages?.count ?? 0}\n\nالأزرار الشفافة داخل الردود يمكن أن تنتقل إلى أمر آخر باستخدام:\nنص الزر = command:اسم_الأمر\nنص الزر = back\nنص الزر = home`,
    {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: [
        [{ text: command.isActive ? "❌ تعطيل" : "✅ تفعيل", callback_data: `cmdadmin:toggle:${commandId}` }, { text: "🗑️ حذف", callback_data: `cmdadmin:delete:${commandId}` }],
        [{ text: "📝 إضافة رد", callback_data: `cmdadmin:addmsg:${commandId}` }, { text: `📋 الردود (${messages?.count ?? 0})`, callback_data: `cmdadmin:msgs:${commandId}` }],
        [{ text: "↩️ قائمة الأوامر", callback_data: "menu:commands" }],
      ] },
    },
  ).catch(() => {});
}

async function showCommandMessages(bot: TelegramBot, chatId: number, msgId: number, commandId: number) {
  const messages = await db.select().from(commandMessagesTable).where(eq(commandMessagesTable.commandId, commandId)).orderBy(asc(commandMessagesTable.orderIndex));
  const keyboard: InlineKeyboardButton[][] = [];
  messages.forEach((message, index) => {
    keyboard.push([{ text: `📄 ${index + 1}. ${getTypeLabel(message.messageType)}`, callback_data: "cmdmsg:noop" }]);
    keyboard.push([
      { text: "👁️ معاينة", callback_data: `cmdmsg:preview:${message.id}` },
      { text: "✏️ تعديل", callback_data: `cmdmsg:edit:${message.id}:${commandId}` },
      ...(index > 0 ? [{ text: "⬆️", callback_data: `cmdmsg:up:${message.id}:${commandId}` }] : []),
      ...(index < messages.length - 1 ? [{ text: "⬇️", callback_data: `cmdmsg:down:${message.id}:${commandId}` }] : []),
      { text: "🗑️", callback_data: `cmdmsg:del:${message.id}:${commandId}` },
    ]);
  });
  keyboard.push([{ text: "📝 إضافة رد", callback_data: `cmdadmin:addmsg:${commandId}` }, { text: "↩️ إدارة الأمر", callback_data: `cmdadmin:manage:${commandId}` }]);
  await bot.editMessageText(`📋 ردود الأمر (${messages.length})`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
}

async function insertCommandMessage(
  commandId: number,
  messageType: string,
  content: string,
  caption?: string,
  contentEntities?: string,
  captionEntities?: string,
  forwardData?: string,
  inlineButtons?: string | null,
) {
  const rows = await db.select({ count: count() }).from(commandMessagesTable).where(eq(commandMessagesTable.commandId, commandId));
  await db.insert(commandMessagesTable).values({
    commandId, messageType, content, caption: caption ?? null,
    contentEntities: contentEntities ?? null, captionEntities: captionEntities ?? null,
    forwardData: forwardData ?? null, inlineButtons: inlineButtons ?? null,
    orderIndex: Number(rows[0]?.count ?? 0),
  });
}

async function reorderCommandMessage(messageId: number, commandId: number, direction: -1 | 1) {
  const messages = await db.select().from(commandMessagesTable).where(eq(commandMessagesTable.commandId, commandId)).orderBy(asc(commandMessagesTable.orderIndex));
  const index = messages.findIndex(message => message.id === messageId);
  const swapIndex = index + direction;
  if (index < 0 || swapIndex < 0 || swapIndex >= messages.length) return;
  const current = messages[index]!;
  const swap = messages[swapIndex]!;
  await Promise.all([
    db.update(commandMessagesTable).set({ orderIndex: swap.orderIndex }).where(eq(commandMessagesTable.id, current.id)),
    db.update(commandMessagesTable).set({ orderIndex: current.orderIndex }).where(eq(commandMessagesTable.id, swap.id)),
  ]);
}

async function showButtonManage(bot: TelegramBot, chatId: number, msgId: number, btnId: number) {
  const [btn] = await db.select().from(fixedButtonsTable).where(eq(fixedButtonsTable.id, btnId));
  if (!btn) { await bot.editMessageText("❌ الزر غير موجود.", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[BACK_MAIN]] } }).catch(() => {}); return; }
  const [msgsRes, subRes] = await Promise.all([
    db.select({ count: count() }).from(buttonMessagesTable).where(eq(buttonMessagesTable.buttonId, btnId)),
    db.select({ count: count() }).from(fixedButtonsTable).where(eq(fixedButtonsTable.parentId, btnId)),
  ]);
  const msgCount = Number(msgsRes[0]?.count ?? 0);
  const subCount = Number(subRes[0]?.count ?? 0);
  const username = getBotUsername();
  const deepLink = username ? `https://t.me/${username}?start=${btn.token}` : `token: ${btn.token}`;

  let parentLine = "";
  if (btn.parentId) {
    const [parent] = await db.select({ label: fixedButtonsTable.label }).from(fixedButtonsTable).where(eq(fixedButtonsTable.id, btn.parentId));
    parentLine = parent ? `\n📂 الزر الأب: ${parent.label}` : "";
  }

  const autoDelLine = `\n⏱️ الحذف التلقائي: ${formatAutoDelete(btn.autoDeleteSeconds)}`;
  const backBtn: InlineKeyboardButton = btn.parentId
    ? { text: "↩️ الزر الأب", callback_data: `btn:manage:${btn.parentId}` }
    : { text: "↩️ قائمة الأزرار", callback_data: "menu:buttons" };

  await bot.editMessageText(
    `🔘 الزر: ${btn.label}\nالحالة: ${btn.isActive ? "✅ مفعّل" : "❌ معطّل"} | الصف: ${btn.rowGroup}${parentLine}\nالرسائل: ${msgCount} | الأزرار الفرعية: ${subCount}${autoDelLine}\n\n🔗 الرابط المباشر:\n${deepLink}`,
    {
      chat_id: chatId, message_id: msgId,
      reply_markup: {
        inline_keyboard: [
          [{ text: btn.isActive ? "❌ تعطيل" : "✅ تفعيل", callback_data: `btn:toggle:${btnId}` }, { text: "🗑️ حذف الزر", callback_data: `btn:delete:${btnId}` }],
          [{ text: "📐 تغيير الصف", callback_data: `btn:setrow:${btnId}` }, { text: "🔄 تجديد الرابط", callback_data: `btn:regen_token:${btnId}` }],
          [{ text: "📝 إضافة رسالة", callback_data: `btn:addmsg:${btnId}` }, { text: `📋 الرسائل (${msgCount})`, callback_data: `btn:msgs:${btnId}` }],
          [{ text: `➕ زر فرعي`, callback_data: `btn:add_sub:${btnId}` }, { text: `📂 الفرعية (${subCount})`, callback_data: `btn:sub_list:${btnId}` }],
          [{ text: `⏱️ مؤقت الحذف`, callback_data: `btn:autodel_menu:${btnId}` }],
          [backBtn],
        ],
      },
    }
  ).catch(() => {});
}

async function showButtonMessages(bot: TelegramBot, chatId: number, msgId: number, btnId: number) {
  const msgs = await db.select().from(buttonMessagesTable).where(eq(buttonMessagesTable.buttonId, btnId)).orderBy(asc(buttonMessagesTable.orderIndex));
  if (msgs.length === 0) {
    await bot.editMessageText("لا توجد رسائل لهذا الزر.", {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: [[{ text: "📝 إضافة رسالة", callback_data: `btn:addmsg:${btnId}` }], [{ text: "↩️ إدارة الزر", callback_data: `btn:manage:${btnId}` }]] },
    }).catch(() => {});
    return;
  }
  const keyboard: InlineKeyboardButton[][] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    const canUp = i > 0;
    const canDown = i < msgs.length - 1;
    keyboard.push([
      { text: `📄 ${i + 1}. ${getTypeLabel(m.messageType)}`, callback_data: `btnmsg:noop` },
      ...(canUp ? [{ text: "⬆️", callback_data: `btnmsg:up:${m.id}:${btnId}` }] : []),
      ...(canDown ? [{ text: "⬇️", callback_data: `btnmsg:down:${m.id}:${btnId}` }] : []),
    ]);
    keyboard.push([
      { text: "👁️ معاينة", callback_data: `btnmsg:preview:${m.id}:${btnId}` },
      { text: "✏️ تعديل", callback_data: `btn:msgs:edit_open:${m.id}:${btnId}` },
      { text: "🗑️ حذف", callback_data: `btnmsg:del_confirm:${m.id}:${btnId}` },
    ]);
  }
  keyboard.push([{ text: "📝 إضافة رسالة", callback_data: `btn:addmsg:${btnId}` }, { text: "↩️ إدارة الزر", callback_data: `btn:manage:${btnId}` }]);
  await bot.editMessageText(`📋 رسائل الزر (${msgs.length}):`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
}

async function showChannelsList(bot: TelegramBot, chatId: number, msgId: number) {
  const channels = await db.select().from(channelsTable);
  let text = `📡 قنوات الاشتراك الإجباري (${channels.length})\n\n`;
  const rows: InlineKeyboardButton[][] = [[{ text: "➕ إضافة قناة", callback_data: "ch:add" }]];
  for (const ch of channels) {
    text += `• ${ch.channelName} (${ch.channelId}) ${ch.isActive ? "✅" : "❌"}\n`;
    rows.push([
      { text: ch.isActive ? "❌ تعطيل" : "✅ تفعيل", callback_data: `ch:toggle:${ch.id}` },
      { text: `🗑️ ${ch.channelName}`, callback_data: `ch:delete:${ch.id}` },
    ]);
  }
  if (channels.length === 0) text += "لا توجد قنوات.";
  rows.push([BACK_MAIN]);
  await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: rows } }).catch(() => {});
}

async function showSettingsMenu(bot: TelegramBot, chatId: number, msgId: number) {
  const settings = await getSettings();
  const protection = settings.contentProtection ? "🔒 مفعّل" : "🔓 معطّل";
  const preview = `⚙️ الإعدادات\n\n📨 رسالة الترحيب: ${settings.startMessage.slice(0, 40)}\n🔒 تقييد المحتوى: ${protection}`;
  await bot.editMessageText(preview, { chat_id: chatId, message_id: msgId, reply_markup: buildSettingsMenu(settings.contentProtection) }).catch(() => {});
}

async function showBroadcastConfirm(bot: TelegramBot, chatId: number, msgId: number | undefined, msgType: string, content: string, caption?: string, inlineButtons?: string) {
  const text = `📢 تأكيد الإذاعة\n\nالنوع: ${getTypeLabel(msgType)}\nالمحتوى: ${content.slice(0, 50)}\n${caption ? `Caption: ${caption.slice(0, 30)}\n` : ""}${inlineButtons ? "أزرار: نعم\n" : ""}`;
  const markup = { inline_keyboard: [[{ text: "📤 إرسال للجميع", callback_data: "broadcast:send" }], [{ text: "❌ إلغاء", callback_data: "menu:broadcast" }]] };
  if (msgId) await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, reply_markup: markup }).catch(() => {});
  else await bot.sendMessage(chatId, text, { reply_markup: markup });
}

// Open edit dialog for existing message
export async function handleBtnMsgsEditOpen(bot: TelegramBot, query: CallbackQuery, adminId: number) {
  const chatId = query.message!.chat.id;
  const msgId = query.message!.message_id;
  const parts = (query.data || "").split(":");
  const mId = parseInt(parts[3]!);
  const btnId = parseInt(parts[4]!);
  const [bm] = await db.select().from(buttonMessagesTable).where(eq(buttonMessagesTable.id, mId));
  if (!bm) return;
  await bot.editMessageText(`✏️ تعديل الرسالة (${getTypeLabel(bm.messageType)})\n\nأرسل المحتوى الجديد الآن، وسيكتشف البوت نوعه وتنسيقه تلقائياً:`, {
    chat_id: chatId, message_id: msgId,
    reply_markup: { inline_keyboard: [[{ text: "↩️ رجوع", callback_data: `btn:msgs:${btnId}` }]] },
  }).catch(() => {});
  setState(adminId, { type: "button_msg_edit_wait_content", buttonId: btnId, msgId: mId });
}

async function showSubButtonsList(bot: TelegramBot, chatId: number, msgId: number, parentId: number) {
  const [parent] = await db.select().from(fixedButtonsTable).where(eq(fixedButtonsTable.id, parentId));
  const subs = await db.select().from(fixedButtonsTable)
    .where(eq(fixedButtonsTable.parentId, parentId))
    .orderBy(asc(fixedButtonsTable.rowGroup), asc(fixedButtonsTable.orderIndex));
  const rows: InlineKeyboardButton[][] = [
    [{ text: "➕ إضافة زر فرعي", callback_data: `btn:add_sub:${parentId}` }],
  ];
  for (const btn of subs) {
    rows.push([{ text: `${btn.isActive ? "✅" : "❌"} ${btn.label} (صف ${btn.rowGroup})`, callback_data: `btn:manage:${btn.id}` }]);
  }
  rows.push([{ text: "↩️ الزر الأب", callback_data: `btn:manage:${parentId}` }]);
  await bot.editMessageText(
    `📂 الأزرار الفرعية لـ "${parent?.label ?? parentId}" (${subs.length})`,
    { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: rows } }
  ).catch(() => {});
}

// ── Media group handler (called from bot/index.ts after buffering) ──────────
export async function handleAdminMediaGroup(bot: TelegramBot, chatId: number, adminId: number, msgs: Message[]) {
  const state = getState(adminId);
  if (state.type !== "button_msg_wait_content" &&
      state.type !== "command_msg_wait_content" &&
      state.type !== "command_msg_edit_wait_content" &&
      state.type !== "button_msg_edit_wait_media_group" &&
      state.type !== "broadcast_wait_media_group" &&
      state.type !== "broadcast_wait_content") {
    return;
  }

  // Collect media items preserving album order (sort by message_id)
  const sorted = [...msgs].sort((a, b) => a.message_id - b.message_id);
  const mediaItems: Array<{ type: string; file_id: string }> = [];
  for (const m of sorted) {
    if (m.photo && m.photo.length > 0) {
      const largest = m.photo[m.photo.length - 1]!;
      mediaItems.push({ type: "photo", file_id: largest.file_id });
    } else if (m.video) {
      mediaItems.push({ type: "video", file_id: m.video.file_id });
    }
  }

  if (mediaItems.length === 0) {
    await bot.sendMessage(chatId, "❌ لم يُتعرف على الألبوم. أرسل صوراً أو فيديوهات معاً في رسالة واحدة.");
    return;
  }

  // Caption: first non-empty caption from the album
  const captionMessage = sorted.find(m => m.caption);
  const caption = captionMessage?.caption ?? null;
  const captionEntities = captionMessage ? jsonValue(captionMessage.caption_entities) : null;
  const content = JSON.stringify(mediaItems);
  const forwarded = sorted.map(getForwardData).filter((value): value is string => Boolean(value));
  const forwardData = forwarded.length === sorted.length
    ? (() => {
        try {
          const parsed = forwarded.map(value => JSON.parse(value) as { fromChatId: number | string; messageIds: number[] });
          const source = parsed[0]?.fromChatId;
          if (source === undefined || parsed.some(item => item.fromChatId !== source)) return undefined;
          return JSON.stringify({ fromChatId: source, messageIds: parsed.flatMap(item => item.messageIds) });
        } catch {
          return undefined;
        }
      })()
    : undefined;

  if (state.type === "button_msg_wait_content") {
    const { buttonId } = state;
    const existingMsgs = await db.select({ count: count() }).from(buttonMessagesTable).where(eq(buttonMessagesTable.buttonId, buttonId));
    await db.insert(buttonMessagesTable).values({
      buttonId,
      messageType: "media_group",
      content,
      caption,
      captionEntities,
      forwardData,
      inlineButtons: null,
      orderIndex: Number(existingMsgs[0]?.count ?? 0),
    });
    resetState(adminId);
    await bot.sendMessage(chatId, `✅ تم إضافة الألبوم (${mediaItems.length} ملف)!`, {
      reply_markup: { inline_keyboard: [[{ text: "↩️ إدارة الزر", callback_data: `btn:manage:${buttonId}` }]] },
    });
    return;
  }

  if (state.type === "command_msg_wait_content") {
    const existingMsgs = await db.select({ count: count() }).from(commandMessagesTable).where(eq(commandMessagesTable.commandId, state.commandId));
    await db.insert(commandMessagesTable).values({
      commandId: state.commandId,
      messageType: "media_group",
      content,
      caption,
      captionEntities,
      forwardData,
      inlineButtons: null,
      orderIndex: Number(existingMsgs[0]?.count ?? 0),
    });
    resetState(adminId);
    await bot.sendMessage(chatId, `✅ تم إضافة الألبوم (${mediaItems.length} ملف)!`, {
      reply_markup: { inline_keyboard: [[{ text: "📝 إضافة رد آخر", callback_data: `cmdadmin:addmsg:${state.commandId}` }], [{ text: "↩️ إدارة الأمر", callback_data: `cmdadmin:manage:${state.commandId}` }]] },
    });
    return;
  }

  if (state.type === "command_msg_edit_wait_content") {
    await db.update(commandMessagesTable).set({
      messageType: forwardData ? "forward" : "media_group",
      content: forwardData ? "" : content,
      caption,
      captionEntities,
      forwardData,
    }).where(and(eq(commandMessagesTable.id, state.msgId), eq(commandMessagesTable.commandId, state.commandId)));
    resetState(adminId);
    await bot.sendMessage(chatId, `✅ تم تحديث الألبوم (${mediaItems.length} ملف)!`, {
      reply_markup: { inline_keyboard: [[{ text: "↩️ ردود الأمر", callback_data: `cmdadmin:msgs:${state.commandId}` }]] },
    });
    return;
  }

  if (state.type === "button_msg_edit_wait_media_group") {
    const { buttonId, msgId: dbMsgId } = state;
    await db.update(buttonMessagesTable)
      .set({ messageType: forwardData ? "forward" : "media_group", content: forwardData ? "" : content, caption, captionEntities, forwardData, inlineButtons: null })
      .where(eq(buttonMessagesTable.id, dbMsgId));
    resetState(adminId);
    await bot.sendMessage(chatId, `✅ تم تحديث الألبوم (${mediaItems.length} ملف)!`, {
      reply_markup: { inline_keyboard: [[{ text: "↩️ رسائل الزر", callback_data: `btn:msgs:${buttonId}` }]] },
    });
    return;
  }

  if (state.type === "broadcast_wait_media_group" || state.type === "broadcast_wait_content") {
    setState(adminId, {
      type: "broadcast_confirm",
      msgType: "media_group",
      content,
      caption: caption ?? undefined,
      captionEntities: captionEntities ?? undefined,
      forwardData,
    });
    await showBroadcastConfirm(bot, chatId, undefined, "media_group", content, caption ?? undefined);
    return;
  }
}

// Reorder helper
async function reorderMsg(mId: number, btnId: number, direction: -1 | 1) {
  const msgs = await db.select().from(buttonMessagesTable).where(eq(buttonMessagesTable.buttonId, btnId)).orderBy(asc(buttonMessagesTable.orderIndex));
  const idx = msgs.findIndex(m => m.id === mId);
  if (idx === -1) return;
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= msgs.length) return;
  const a = msgs[idx]!;
  const b = msgs[swapIdx]!;
  await Promise.all([
    db.update(buttonMessagesTable).set({ orderIndex: b.orderIndex }).where(eq(buttonMessagesTable.id, a.id)),
    db.update(buttonMessagesTable).set({ orderIndex: a.orderIndex }).where(eq(buttonMessagesTable.id, b.id)),
  ]);
}
