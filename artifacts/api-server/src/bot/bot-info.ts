/** Shared bot state to break circular imports between index.ts ↔ panel.ts / send.ts */

import type TelegramBot from "node-telegram-bot-api";

let _bot: TelegramBot | null = null;
let _botUsername = "";

export function getBot(): TelegramBot | null { return _bot; }
export function setBot(b: TelegramBot): void { _bot = b; }

export function getBotUsername(): string { return _botUsername; }
export function setBotUsername(u: string): void { _botUsername = u; }
