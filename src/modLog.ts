import type { Telegraf } from "telegraf";
import { QUARANTINE_CHAT, unbanUser } from "./lib.ts";
import { isAdmin } from "./promote.ts";

// Automated moderation actions (blocks, mutes) are announced to the mod chat
// so admins see what the bot did on its own. Notifications about users carry a
// button that lifts the restriction with one click; only admins of the
// affected chat may press it.

export const MOD_UNBAN_PREFIX = "modunban";

export type ModAction = "block" | "mute24h";

export type ModTarget =
  | { kind: "user"; id: number; first_name?: string; username?: string }
  | { kind: "channel"; id: number; username?: string; title?: string };

const ACTION_TITLES: Record<ModAction, string> = {
  block: "🚫 Блокировка",
  mute24h: "🔇 Мут на 24 часа",
};

const REASON_LIMIT = 160;

// Read lazily: dotenv.config() runs after this module is evaluated.
export function modLogChat(): string | number {
  return process.env.MOD_CHAT_ID || QUARANTINE_CHAT;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function modTargetFromMessage(message: {
  from?: { id: number; first_name?: string; username?: string };
  sender_chat?: { id: number; username?: string; title?: string };
}): ModTarget {
  if (message.sender_chat) {
    return {
      kind: "channel",
      id: message.sender_chat.id,
      username: message.sender_chat.username,
      title: message.sender_chat.title,
    };
  }
  return {
    kind: "user",
    id: message.from?.id ?? 0,
    first_name: message.from?.first_name,
    username: message.from?.username,
  };
}

export function formatModAction({
  action,
  target,
  chatId,
  chatTitle,
  reason,
  quarantineMessageId,
}: {
  action: ModAction;
  target: ModTarget;
  chatId: number;
  chatTitle?: string;
  reason?: string | null;
  quarantineMessageId?: number;
}): string {
  const who =
    target.kind === "user"
      ? `Кто: ${[target.first_name, target.username ? `@${target.username}` : null, target.id]
          .filter(Boolean)
          .join(" ")}`
      : `Кто: канал ${target.title ?? (target.username ? `@${target.username}` : target.id)}`;
  const lines = [ACTION_TITLES[action], who, `Чат: ${chatTitle ?? "—"} (${chatId})`];
  if (reason) lines.push(`Причина: ${truncate(reason, REASON_LIMIT)}`);
  if (quarantineMessageId) {
    const quarantine = QUARANTINE_CHAT.replace(/^@/, "");
    lines.push(`Карантин: https://t.me/${quarantine}/${quarantineMessageId}`);
  }
  return lines.join("\n");
}

export function notifyModAction(
  telegram: Telegraf["telegram"],
  opts: {
    action: ModAction;
    target: ModTarget;
    chatId: number;
    chatTitle?: string;
    reason?: string | null;
    quarantineMessageId?: number;
  }
): Promise<unknown> {
  const text = formatModAction(opts);
  const extra: Record<string, unknown> = {
    link_preview_options: { is_disabled: true },
  };
  if (opts.target.kind === "user") {
    extra.reply_markup = {
      inline_keyboard: [
        [
          {
            text: "Снять ограничения",
            callback_data: `${MOD_UNBAN_PREFIX}:${opts.chatId}:${opts.target.id}`,
          },
        ],
      ],
    };
  }
  return telegram.sendMessage(modLogChat(), text, extra).catch((error: unknown) => {
    console.log("CANT SEND MOD LOG:", error);
  });
}

export function parseModUnbanCallback(
  data: string
): { chatId: number; userId: number } | null {
  const match = new RegExp(`^${MOD_UNBAN_PREFIX}:(-?\\d+):(\\d+)$`).exec(data);
  if (!match) return null;
  return { chatId: Number(match[1]), userId: Number(match[2]) };
}

export function setupModLog(bot: Telegraf, { myChannels }: { myChannels: string[] }) {
  bot.action(new RegExp(`^${MOD_UNBAN_PREFIX}:`), async (ctx) => {
    if (!ctx.callbackQuery || !("data" in ctx.callbackQuery)) return;
    const parsed = parseModUnbanCallback(ctx.callbackQuery.data);
    if (!parsed) {
      await ctx.answerCbQuery().catch(() => {});
      return;
    }
    const { chatId, userId } = parsed;
    const clicker = ctx.callbackQuery.from;

    const admin = await isAdmin(ctx.telegram, chatId, clicker, undefined, myChannels);
    if (!admin) {
      await ctx.answerCbQuery("Только для админов.", { show_alert: true });
      return;
    }

    try {
      await unbanUser(ctx.telegram, chatId, userId);
    } catch (error) {
      console.error(`modLog: failed to unban ${userId} in ${chatId}:`, error);
      await ctx.answerCbQuery("Не удалось снять ограничения.", { show_alert: true });
      return;
    }

    const who = clicker.username ? `@${clicker.username}` : clicker.first_name;
    const base =
      ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
        ? ctx.callbackQuery.message.text
        : "";
    await ctx
      .editMessageText(`${base}\n\n✅ Ограничения снял ${who}.`)
      .catch(() => {});
    console.log(`modLog: ${clicker.id} unbanned ${userId} in ${chatId}`);
    await ctx.answerCbQuery("Ограничения сняты.");
  });
}
