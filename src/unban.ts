import type { Telegraf } from "telegraf";
import { unbanUser } from "./lib.ts";
import { findUserIdByUsername, isAdmin, parseUserTarget } from "./promote.ts";

// /unban lets a chat admin lift a restriction (or a ban) the bot or an admin
// put on a member, returning them to the chat's default member permissions.

type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name: string;
  username?: string;
};

const RESULT_TTL_MS = 15_000;

function displayName(user: TelegramUser) {
  return user.username ? `@${user.username}` : user.first_name;
}

function deleteLater(
  telegram: Telegraf["telegram"],
  chatId: number,
  messageId: number
) {
  setTimeout(() => {
    telegram.deleteMessage(chatId, messageId).catch((error) => {
      console.log("CANT DELETE UNBAN MESSAGE:", messageId, error);
    });
  }, RESULT_TTL_MS);
}

export function setupUnban(bot: Telegraf, { myChannels }: { myChannels: string[] }) {
  bot.command("unban", async (ctx, next) => {
    const chatId = ctx.chat.id;
    const message = ctx.message;

    const admin = await isAdmin(
      ctx.telegram,
      chatId,
      message.from,
      message.sender_chat as { id: number; username?: string } | undefined,
      myChannels
    );
    // For everyone else it's a regular message that still goes through the filters.
    if (!admin) return next();

    ctx.deleteMessage(message.message_id).catch(() => {});

    const target = parseUserTarget(message as any, ctx.botInfo?.username);
    if (!target) {
      const sent = await ctx.reply(
        "Укажите пользователя: /unban @username или ответьте командой на его сообщение."
      );
      deleteLater(ctx.telegram, chatId, sent.message_id);
      return;
    }

    let user: TelegramUser;
    if (target.kind === "user") {
      user = target.user;
    } else {
      const userId = await findUserIdByUsername(target.username);
      if (!userId) {
        const sent = await ctx.reply(
          `Не знаю @${target.username}: бот еще не видел его сообщений. Ответьте командой /unban на его сообщение.`
        );
        deleteLater(ctx.telegram, chatId, sent.message_id);
        return;
      }
      user = { id: userId, first_name: target.username, username: target.username };
    }

    let result: "unbanned" | "restored";
    try {
      result = await unbanUser(ctx.telegram, chatId, user.id);
    } catch (error) {
      console.error(`unban: failed to restore ${user.id} in ${chatId}:`, error);
      const sent = await ctx.reply(`Не удалось снять ограничения с ${displayName(user)}.`);
      deleteLater(ctx.telegram, chatId, sent.message_id);
      return;
    }

    const text =
      result === "unbanned"
        ? `Бан с ${displayName(user)} снят, права как у обычных участников.`
        : `Ограничения с ${displayName(user)} сняты, права как у обычных участников.`;
    console.log(`unban: ${message.from?.id} ${result} ${user.id} in ${chatId}`);

    const sent = await ctx.reply(text);
    deleteLater(ctx.telegram, chatId, sent.message_id);
  });
}
