import type { InlineKeyboardButton, InlineKeyboardMarkup } from "node-telegram-bot-api";

/**
 * Parse inline buttons from raw text format:
 * "btn=url\nbtn2=url2+btn3=url3"
 * Each line is a row, + separates buttons in same row
 */
export function parseInlineButtons(raw: string, commandId?: number): InlineKeyboardButton[][] {
  if (!raw || !raw.trim()) return [];
  const rows = raw.trim().split("\n");
  const keyboard: InlineKeyboardButton[][] = [];
  for (const row of rows) {
    const parts = row.split("+").map((s) => s.trim()).filter(Boolean);
    const rowButtons: InlineKeyboardButton[] = [];
    for (const part of parts) {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) continue;
      const text = part.slice(0, eqIdx).trim();
      const url = part.slice(eqIdx + 1).trim();
      if (!text || !url) continue;
       if (commandId && (url.startsWith("command:") || url.startsWith("cmd:"))) {
         const target = url.replace(/^(command:|cmd:)/, "").replace(/^\//, "").trim().toLowerCase();
         rowButtons.push({ text, callback_data: target ? `cmd:${commandId}:${target}` : `cmd:${commandId}` });
         continue;
       }
       if (commandId && ["back", "رجوع", "home", "الرئيسية"].includes(url.toLowerCase())) {
         rowButtons.push({ text, callback_data: `cmd:${commandId}:${url.toLowerCase()}` });
         continue;
       }
       let finalUrl = url;
      if (!finalUrl.startsWith("http") && !finalUrl.startsWith("tg://") && finalUrl.startsWith("@")) {
        finalUrl = `https://t.me/${finalUrl.slice(1)}`;
      } else if (!finalUrl.startsWith("http") && !finalUrl.startsWith("tg://") && !finalUrl.startsWith("//")) {
        finalUrl = `https://${finalUrl}`;
      }
      rowButtons.push({ text, url: finalUrl });
    }
    if (rowButtons.length > 0) keyboard.push(rowButtons);
  }
  return keyboard;
}

export function buildInlineMarkup(raw: string | undefined | null, commandId?: number): InlineKeyboardMarkup | undefined {
  if (!raw) return undefined;
  const keyboard = parseInlineButtons(raw, commandId);
  if (keyboard.length === 0) return undefined;
  return { inline_keyboard: keyboard };
}
