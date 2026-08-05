/** sendBotMessage + broadcastMessage extracted here to break the circular import
 *  between bot/index.ts (exports getBot) and bot/admin/panel.ts (uses these helpers). */

import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";
import { buildInlineMarkup } from "./keyboard";
import { getBot } from "./bot-info";

export type StoredMessageOptions = {
  contentEntities?: string | null;
  captionEntities?: string | null;
  forwardData?: string | null;
  interactiveCommandId?: number;
  botOverride?: TelegramBot;
};

/**
 * Send a single bot message. Returns the sent message_id(s) (for auto-delete scheduling).
 * For media_group, returns an array of message_ids.
 * Pass protectContent=true to prevent forwarding/saving (Telegram content protection).
 */
export async function sendBotMessage(
  chatId: number,
  messageType: string,
  content: string,
  caption?: string,
  inlineButtons?: string,
  protectContent?: boolean,
  options?: StoredMessageOptions,
): Promise<number | number[] | undefined> {
  const bot = options?.botOverride ?? getBot();
  if (!bot) return;
  const markup = inlineButtons ? buildInlineMarkup(inlineButtons, options?.interactiveCommandId) : undefined;
  const contentEntities = parseEntities(options?.contentEntities);
  const captionEntities = parseEntities(options?.captionEntities);
  const contentParseMode = contentEntities.length === 0 ? inferParseMode(content) : undefined;
  const captionParseMode = captionEntities.length === 0 && caption ? inferParseMode(caption) : undefined;
  const extra: Record<string, unknown> = {
    ...(contentEntities.length > 0 ? { entities: contentEntities } : {}),
    ...(contentParseMode ? { parse_mode: contentParseMode } : {}),
    ...(markup ? { reply_markup: markup } : {}),
    ...(protectContent ? { protect_content: true } : {}),
  };
  try {
    if (messageType === "forward" && options?.forwardData) {
      const forward = JSON.parse(options.forwardData) as { fromChatId: number | string; messageIds: number[] };
      if (forward.fromChatId === undefined || forward.messageIds.length === 0) return undefined;
      const forwarded = forward.messageIds.length === 1
        ? [await bot.forwardMessage(chatId, forward.fromChatId, forward.messageIds[0]!, {
          ...(protectContent ? { protect_content: true } : {}),
        })]
        : await bot.forwardMessages(chatId, forward.fromChatId, forward.messageIds, {
          ...(protectContent ? { protect_content: true } : {}),
        });
      if (markup) {
        for (const message of forwarded) {
          if (message?.message_id) {
            await bot.editMessageReplyMarkup(markup, { chat_id: chatId, message_id: message.message_id }).catch(() => {});
          }
        }
      }
      return forwarded.map(message => message.message_id);
    }

    let sent;
    switch (messageType) {
      case "text":      sent = await bot.sendMessage(chatId, content, extra as Parameters<typeof bot.sendMessage>[2]); return sent?.message_id;
      case "photo":     sent = await bot.sendPhoto(chatId, content, { ...withoutContentFormatting(extra), caption, ...(captionEntities.length > 0 ? { caption_entities: captionEntities } : {}), ...(captionParseMode ? { parse_mode: captionParseMode } : {}) } as Parameters<typeof bot.sendPhoto>[2]); return sent?.message_id;
      case "video":     sent = await bot.sendVideo(chatId, content, { ...withoutContentFormatting(extra), caption, ...(captionEntities.length > 0 ? { caption_entities: captionEntities } : {}), ...(captionParseMode ? { parse_mode: captionParseMode } : {}) } as Parameters<typeof bot.sendVideo>[2]); return sent?.message_id;
      case "audio":     sent = await bot.sendAudio(chatId, content, { ...withoutContentFormatting(extra), caption, ...(captionEntities.length > 0 ? { caption_entities: captionEntities } : {}), ...(captionParseMode ? { parse_mode: captionParseMode } : {}) } as Parameters<typeof bot.sendAudio>[2]); return sent?.message_id;
      case "document":  sent = await bot.sendDocument(chatId, content, { ...withoutContentFormatting(extra), caption, ...(captionEntities.length > 0 ? { caption_entities: captionEntities } : {}), ...(captionParseMode ? { parse_mode: captionParseMode } : {}) } as Parameters<typeof bot.sendDocument>[2]); return sent?.message_id;
      case "animation": sent = await bot.sendAnimation(chatId, content, { ...withoutContentFormatting(extra), caption, ...(captionEntities.length > 0 ? { caption_entities: captionEntities } : {}), ...(captionParseMode ? { parse_mode: captionParseMode } : {}) } as Parameters<typeof bot.sendAnimation>[2]); return sent?.message_id;
      case "voice":     sent = await bot.sendVoice(chatId, content, { ...withoutContentFormatting(extra), caption, ...(captionEntities.length > 0 ? { caption_entities: captionEntities } : {}), ...(captionParseMode ? { parse_mode: captionParseMode } : {}) } as Parameters<typeof bot.sendVoice>[2]); return sent?.message_id;
      case "video_note": sent = await bot.sendVideoNote(chatId, content, withoutContentFormatting(extra) as Parameters<typeof bot.sendVideoNote>[2]); return sent?.message_id;
      case "sticker":   sent = await bot.sendSticker(chatId, content, withoutContentFormatting(extra) as Parameters<typeof bot.sendSticker>[2]); return sent?.message_id;
      case "location": {
        const location = JSON.parse(content) as { latitude: number; longitude: number };
        sent = await bot.sendLocation(chatId, location.latitude, location.longitude, withoutContentFormatting(extra) as Parameters<typeof bot.sendLocation>[3]);
        return sent?.message_id;
      }
      case "venue": {
        const venue = JSON.parse(content) as { location?: { latitude: number; longitude: number }; latitude?: number; longitude?: number; title: string; address: string };
        const latitude = venue.location?.latitude ?? venue.latitude;
        const longitude = venue.location?.longitude ?? venue.longitude;
        sent = await bot.sendVenue(chatId, latitude!, longitude!, venue.title, venue.address, withoutContentFormatting(extra) as Parameters<typeof bot.sendVenue>[5]);
        return sent?.message_id;
      }
      case "contact": {
        const contact = JSON.parse(content) as { phone_number: string; first_name: string; last_name?: string; vcard?: string };
        sent = await bot.sendContact(chatId, contact.phone_number, contact.first_name, withoutContentFormatting(extra) as Parameters<typeof bot.sendContact>[3]);
        return sent?.message_id;
      }
      case "poll": {
        const poll = JSON.parse(content) as { question: string; options: string[]; is_anonymous?: boolean; type?: "regular" | "quiz"; allows_multiple_answers?: boolean };
        sent = await bot.sendPoll(chatId, poll.question, poll.options as unknown as Parameters<typeof bot.sendPoll>[2], {
          ...withoutContentFormatting(extra),
          is_anonymous: poll.is_anonymous,
          type: poll.type,
          allows_multiple_answers: poll.allows_multiple_answers,
        } as Parameters<typeof bot.sendPoll>[3]);
        return sent?.message_id;
      }
      case "dice": {
        const dice = JSON.parse(content) as { emoji?: string };
        sent = await bot.sendDice(chatId, { ...withoutContentFormatting(extra), emoji: dice.emoji } as Parameters<typeof bot.sendDice>[1]);
        return sent?.message_id;
      }
      case "media_group": {
        const items = JSON.parse(content) as Array<{ type: string; file_id: string }>;
        if (items.length === 0) return undefined;
        const media = items.map((item, i) => {
          const base: Record<string, unknown> = { type: item.type, media: item.file_id };
         if (i === 0 && caption) {
            base.caption = caption;
            if (captionEntities.length > 0) base.caption_entities = captionEntities;
           else if (captionParseMode) base.parse_mode = captionParseMode;
          }
          return base;
        });
        const opts: Record<string, unknown> = {};
        if (protectContent) opts.protect_content = true;
        const sentMsgs = await bot.sendMediaGroup(chatId, media as Parameters<typeof bot.sendMediaGroup>[1], opts as Parameters<typeof bot.sendMediaGroup>[2]);
        return Array.isArray(sentMsgs) ? sentMsgs.map(m => m.message_id) : undefined;
      }
      default:          sent = await bot.sendMessage(chatId, content, extra as Parameters<typeof bot.sendMessage>[2]); return sent?.message_id;
    }
  } catch (err) {
    logger.warn({ err, chatId, messageType }, "sendBotMessage error");
    return undefined;
  }
}

function parseEntities(value?: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function broadcastMessage(
  msgType: string,
  content: string,
  caption?: string,
  inlineButtons?: string,
  options?: StoredMessageOptions,
): Promise<number> {
  const bot = getBot();
  if (!bot) return 0;
  const users = await db.select().from(usersTable);
  let count = 0;
  for (const user of users) {
    if (user.isBlockedBot) continue;
    try {
      const sent = await sendBotMessage(parseInt(user.telegramId), msgType, content, caption, inlineButtons, false, options);
      if (sent === undefined) continue;
      count++;
      await new Promise(r => setTimeout(r, 35));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (m.includes("bot was blocked") || m.includes("user is deactivated") || m.includes("chat not found")) {
        await db.update(usersTable).set({ isBlockedBot: true }).where(eq(usersTable.telegramId, user.telegramId));
      } else {
        logger.warn({ err, telegramId: user.telegramId }, "broadcast send error");
      }
    }
  }
  return count;
}

function withoutContentFormatting(extra: Record<string, unknown>): Record<string, unknown> {
  const { entities: _entities, parse_mode: _parseMode, ...rest } = extra;
  return rest;
}

function inferParseMode(value: string): "HTML" | "Markdown" | "MarkdownV2" | undefined {
  if (!value) return undefined;
  if (/<\/?[a-z][^>]*>/i.test(value)) return "HTML";
  if (/\\[_*[\]()~`>#+\-=|{}.!]/.test(value) || /\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~/.test(value)) return "MarkdownV2";
  if (/\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]]+\]\([^)]+\)/.test(value)) return "Markdown";
  return undefined;
}

export function textFormatting(text: string, entities?: string | null): Record<string, unknown> {
  const parsed = parseEntities(entities);
  if (parsed.length > 0) return { entities: parsed };
  const parseMode = inferParseMode(text);
  return parseMode ? { parse_mode: parseMode } : {};
}
