import type { InlineKeyboardMarkup, InlineKeyboardButton } from "node-telegram-bot-api";

export const MAIN_MENU: InlineKeyboardMarkup = {
  inline_keyboard: [
    [
      { text: "📊 إحصائيات", callback_data: "menu:stats" },
      { text: "📢 إذاعة", callback_data: "menu:broadcast" },
    ],
    [
      { text: "👥 المستخدمون", callback_data: "menu:users" },
      { text: "🔘 الأزرار الثابتة", callback_data: "menu:buttons" },
    ],
    [{ text: "⌨️ الأوامر المخصصة", callback_data: "menu:commands" }],
    [
      { text: "📡 قنوات الاشتراك", callback_data: "menu:channels" },
      { text: "⚙️ الإعدادات", callback_data: "menu:settings" },
    ],
  ],
};

export const BACK_MAIN: InlineKeyboardButton = {
  text: "↩️ القائمة الرئيسية",
  callback_data: "menu:main",
};

export const MSG_TYPES_KEYBOARD: InlineKeyboardMarkup = {
  inline_keyboard: [
    [
      { text: "📝 نص", callback_data: "type:text" },
      { text: "🖼️ صورة", callback_data: "type:photo" },
      { text: "🎥 فيديو", callback_data: "type:video" },
    ],
    [
      { text: "🎵 صوت", callback_data: "type:audio" },
      { text: "📄 ملف", callback_data: "type:document" },
      { text: "🎞️ GIF", callback_data: "type:animation" },
    ],
    [{ text: "📸 ألبوم (صور/فيديو)", callback_data: "type:media_group" }],
    [{ text: "↩️ رجوع", callback_data: "menu:broadcast" }],
  ],
};

export const MSG_TYPES_KEYBOARD_BTN = (buttonId: number): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [
      { text: "📝 نص", callback_data: `btype:${buttonId}:text` },
      { text: "🖼️ صورة", callback_data: `btype:${buttonId}:photo` },
      { text: "🎥 فيديو", callback_data: `btype:${buttonId}:video` },
    ],
    [
      { text: "🎵 صوت", callback_data: `btype:${buttonId}:audio` },
      { text: "📄 ملف", callback_data: `btype:${buttonId}:document` },
      { text: "🎞️ GIF", callback_data: `btype:${buttonId}:animation` },
    ],
    [{ text: "📸 ألبوم (صور/فيديو)", callback_data: `btype:${buttonId}:media_group` }],
    [{ text: "↩️ رجوع", callback_data: `btn:manage:${buttonId}` }],
  ],
});

export const MSG_TYPES_EDIT_KEYBOARD = (buttonId: number, msgId: number): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [
      { text: "📝 نص", callback_data: `btedit:${buttonId}:${msgId}:text` },
      { text: "🖼️ صورة", callback_data: `btedit:${buttonId}:${msgId}:photo` },
      { text: "🎥 فيديو", callback_data: `btedit:${buttonId}:${msgId}:video` },
    ],
    [
      { text: "🎵 صوت", callback_data: `btedit:${buttonId}:${msgId}:audio` },
      { text: "📄 ملف", callback_data: `btedit:${buttonId}:${msgId}:document` },
      { text: "🎞️ GIF", callback_data: `btedit:${buttonId}:${msgId}:animation` },
    ],
    [{ text: "📸 ألبوم (صور/فيديو)", callback_data: `btedit:${buttonId}:${msgId}:media_group` }],
    [{ text: "↩️ رجوع", callback_data: `btn:msgs:${buttonId}` }],
  ],
});

export const USERS_MENU: InlineKeyboardMarkup = {
  inline_keyboard: [
    [
      { text: "📋 قائمة المستخدمين", callback_data: "users:list:0" },
      { text: "⛔ المحظورون", callback_data: "users:banned:0" },
    ],
    [
      { text: "🔨 حظر مستخدم", callback_data: "users:ban" },
      { text: "✅ رفع حظر مستخدم", callback_data: "users:unban" },
    ],
    [{ text: "🔓 رفع الحظر عن الكل", callback_data: "users:unban_all" }],
    [BACK_MAIN],
  ],
};

export const COMMANDS_MENU: InlineKeyboardMarkup = {
  inline_keyboard: [
    [{ text: "➕ إضافة أمر", callback_data: "cmdadmin:add" }],
    [BACK_MAIN],
  ],
};

// Settings labels and defaults (for display)
export const settingMeta: Record<string, { label: string; defaultVal: string }> = {
  startMessage:       { label: "رسالة الترحيب", defaultVal: "مرحباً! أهلاً وسهلاً بك 🎉" },
  startButtons:       { label: "أزرار رسالة الترحيب (صيغة: نص=رابط)", defaultVal: "" },
  subscriptionMessage:{ label: "رسالة الاشتراك الإجباري", defaultVal: "يجب عليك الاشتراك في القنوات التالية أولاً:" },
  fixedButtonsMessage:{ label: "رسالة الأزرار الثابتة", defaultVal: "استخدم الازرار بالاسفل لتصفح المحتوى" },
};

export function buildSettingsMenu(contentProtection = false): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "📨 رسالة الترحيب",          callback_data: "setting:startMessage" }],
      [{ text: "🔗 أزرار رسالة الترحيب",    callback_data: "setting:startButtons" }],
      [{ text: "📡 رسالة الاشتراك",          callback_data: "setting:subscriptionMessage" }],
      [{ text: "💬 رسالة الأزرار الثابتة",   callback_data: "setting:fixedButtonsMessage" }],
      [{ text: `${contentProtection ? "🔒 تقييد المحتوى: مفعّل" : "🔓 تقييد المحتوى: معطّل"}`, callback_data: "setting:toggle_content_protection" }],
      [BACK_MAIN],
    ],
  };
}

/** Auto-delete presets keyboard for a button */
export function buildAutoDeleteMenu(btnId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🚫 بدون حذف", callback_data: `btn:autodel:${btnId}:0` },
        { text: "30 ثانية",    callback_data: `btn:autodel:${btnId}:30` },
      ],
      [
        { text: "دقيقة",       callback_data: `btn:autodel:${btnId}:60` },
        { text: "5 دقائق",     callback_data: `btn:autodel:${btnId}:300` },
      ],
      [
        { text: "10 دقائق",    callback_data: `btn:autodel:${btnId}:600` },
        { text: "30 دقيقة",    callback_data: `btn:autodel:${btnId}:1800` },
      ],
      [
        { text: "ساعة",        callback_data: `btn:autodel:${btnId}:3600` },
        { text: "✏️ مخصص",     callback_data: `btn:autodel:${btnId}:custom` },
      ],
      [{ text: "↩️ رجوع", callback_data: `btn:manage:${btnId}` }],
    ],
  };
}

export function formatAutoDelete(secs: number | null | undefined): string {
  if (!secs) return "معطّل";
  if (secs < 60)   return `${secs} ثانية`;
  if (secs < 3600) return `${secs / 60} دقيقة`;
  return `${secs / 3600} ساعة`;
}
