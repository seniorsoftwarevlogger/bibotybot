import type { Collection, Db } from "mongodb";
import type { Telegraf } from "telegraf";
import { isTelegramServiceUser } from "./helpers.ts";
import { getLevel, getRank, RANKS, type Rank, setOverride } from "./permissions.ts";

// /promote lets a channel or chat admin grant a rank out of turn. The bot
// answers with one button per rank; a click by an admin stores the override
// (see setOverride) and updates the member tag right away.

type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name: string;
  username?: string;
};

type Entity = { type: string; offset: number; length: number; user?: TelegramUser };

type KnownUserDoc = { username: string; user_id: number; updated_at: Date };

export const PROMOTE_PREFIX = "promote";
const RESULT_TTL_MS = 15_000;

// Telegram bots can't resolve @username to an id, so remember who we've seen.
let knownUsers: Collection<KnownUserDoc> | null = null;
const knownUsersCache = new Map<string, number>();

export function initPromote(db: Db) {
  knownUsers = db.collection<KnownUserDoc>("known_users");
}

export function rememberUser(user?: TelegramUser) {
  if (!user?.username || user.is_bot) return;

  const username = user.username.toLowerCase();
  if (knownUsersCache.get(username) === user.id) return;
  knownUsersCache.set(username, user.id);

  knownUsers
    ?.updateOne(
      { username },
      { $set: { user_id: user.id, updated_at: new Date() } },
      { upsert: true }
    )
    .catch((error) => console.error("promote: failed to remember user", error));
}

export async function findUserIdByUsername(username: string): Promise<number | null> {
  const key = username.replace(/^@/, "").toLowerCase();
  const cached = knownUsersCache.get(key);
  if (cached) return cached;

  const doc = await knownUsers?.findOne({ username: key }).catch((error) => {
    console.error("promote: failed to look up user", error);
    return null;
  });
  if (!doc) return null;

  knownUsersCache.set(key, doc.user_id);
  return doc.user_id;
}

export type PromoteTarget =
  | { kind: "user"; user: TelegramUser }
  | { kind: "username"; username: string };

// Target comes from, in order: a replied-to message, a mention of a user
// without a username (text_mention), or an @username in the command.
export function parsePromoteTarget(message: {
  text?: string;
  entities?: Entity[];
  reply_to_message?: { from?: TelegramUser; sender_chat?: unknown };
}, botUsername?: string): PromoteTarget | null {
  const replied = message.reply_to_message;
  if (
    replied?.from &&
    !replied.sender_chat &&
    !replied.from.is_bot &&
    !isTelegramServiceUser(replied.from)
  ) {
    return { kind: "user", user: replied.from };
  }

  for (const entity of message.entities ?? []) {
    if (entity.type === "text_mention" && entity.user) {
      return { kind: "user", user: entity.user };
    }
    if (entity.type === "mention" && message.text) {
      const username = message.text
        .slice(entity.offset + 1, entity.offset + entity.length)
        .toLowerCase();
      if (username !== botUsername?.toLowerCase()) return { kind: "username", username };
    }
  }

  return null;
}

export function promoteKeyboard(userId: number) {
  return {
    inline_keyboard: [
      RANKS.slice()
        .reverse()
        .map((rank) => ({
          text: `${rank.tag} (${rank.count}+)`,
          callback_data: `${PROMOTE_PREFIX}:${userId}:${rank.tag}`,
        })),
      [
        { text: "Сбросить", callback_data: `${PROMOTE_PREFIX}:${userId}:reset` },
        { text: "Отмена", callback_data: `${PROMOTE_PREFIX}:${userId}:cancel` },
      ],
    ],
  };
}

export function parsePromoteCallback(data: string) {
  const match = new RegExp(`^${PROMOTE_PREFIX}:(\\d+):(\\w+)$`).exec(data);
  if (!match) return null;

  const userId = Number(match[1]);
  const action = match[2];
  if (action === "reset" || action === "cancel") return { userId, action } as const;

  const rank = RANKS.find((r) => r.tag === action);
  return rank ? ({ userId, action: "set", rank } as const) : null;
}

// Admin of this chat, anonymous admin of this chat, or admin of one of our
// channels (posting as the channel or clicking as themselves).
export async function isAdmin(
  telegram: Telegraf["telegram"],
  chatId: number,
  user: TelegramUser | undefined,
  senderChat: { id: number; username?: string } | undefined,
  myChannels: string[]
): Promise<boolean> {
  if (senderChat) {
    return (
      senderChat.id === chatId ||
      myChannels.includes(senderChat.username ?? "")
    );
  }
  if (!user) return false;

  const chats: (number | string)[] = [
    chatId,
    ...myChannels.filter(Boolean).map((channel) => `@${channel}`),
  ];
  for (const chat of chats) {
    const member = await telegram
      .getChatMember(chat, user.id)
      .catch(() => null);
    if (member?.status === "creator" || member?.status === "administrator") {
      return true;
    }
  }
  return false;
}

function displayName(user: TelegramUser) {
  return user.username ? `@${user.username}` : user.first_name;
}

function deleteLater(telegram: Telegraf["telegram"], chatId: number, messageId: number) {
  setTimeout(() => {
    telegram.deleteMessage(chatId, messageId).catch((error) => {
      console.log("CANT DELETE PROMOTE MESSAGE:", messageId, error);
    });
  }, RESULT_TTL_MS);
}

export function setupPromote(
  bot: Telegraf,
  {
    myChannels,
    applyRankTag,
  }: {
    myChannels: string[];
    applyRankTag: (chatId: number, userId: number, rank: Rank) => void;
  }
) {
  bot.command("promote", async (ctx, next) => {
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

    const target = parsePromoteTarget(message as any, ctx.botInfo?.username);
    if (!target) {
      const sent = await ctx.reply(
        "Укажите пользователя: /promote @username или ответьте командой на его сообщение."
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
          `Не знаю @${target.username}: бот еще не видел его сообщений. Ответьте командой /promote на его сообщение.`
        );
        deleteLater(ctx.telegram, chatId, sent.message_id);
        return;
      }
      user = { id: userId, first_name: target.username, username: target.username };
    }

    const level = await getLevel(chatId, user.id);
    const rank = getRank(level.messageCount);
    await ctx.reply(
      [
        `Уровень для ${displayName(user)}`,
        `Сейчас: ${rank ?? "—"}, сообщений: ${level.realMessageCount}` +
          (level.override !== null ? `, назначено вручную: ${level.override}` : ""),
      ].join("\n"),
      { reply_markup: promoteKeyboard(user.id) }
    );
  });

  bot.action(new RegExp(`^${PROMOTE_PREFIX}:`), async (ctx) => {
    if (!ctx.callbackQuery || !("data" in ctx.callbackQuery)) return;
    const parsed = parsePromoteCallback(ctx.callbackQuery.data);
    const chatId = ctx.callbackQuery.message?.chat.id;
    const promptId = ctx.callbackQuery.message?.message_id;
    if (!parsed || !chatId || !promptId) {
      await ctx.answerCbQuery();
      return;
    }

    const admin = await isAdmin(
      ctx.telegram,
      chatId,
      ctx.callbackQuery.from,
      undefined,
      myChannels
    );
    if (!admin) {
      await ctx.answerCbQuery("Только для админов.", { show_alert: true });
      return;
    }

    if (parsed.action === "cancel") {
      await ctx.answerCbQuery();
      await ctx.deleteMessage(promptId).catch(() => {});
      return;
    }

    const member = await ctx.telegram
      .getChatMember(chatId, parsed.userId)
      .catch(() => null);
    const name = member ? displayName(member.user) : String(parsed.userId);

    try {
      await setOverride(
        chatId,
        parsed.userId,
        parsed.action === "set" ? parsed.rank.count : null,
        ctx.callbackQuery.from.id
      );
    } catch (error) {
      console.error("promote: failed to save override", error);
      await ctx.answerCbQuery("Не удалось сохранить уровень.", { show_alert: true });
      return;
    }

    const level = await getLevel(chatId, parsed.userId);
    const rank = getRank(level.messageCount);
    applyRankTag(chatId, parsed.userId, rank);

    const text =
      parsed.action === "set"
        ? `${name} получил уровень ${rank ?? "—"}.`
        : `${name}: ручной уровень сброшен, сейчас ${rank ?? "—"}.`;
    console.log(
      `promote: ${ctx.callbackQuery.from.id} ${parsed.action} ${parsed.userId} in ${chatId} -> ${rank}`
    );

    await ctx.answerCbQuery(text);
    await ctx.editMessageText(text).catch(() => {});
    deleteLater(ctx.telegram, chatId, promptId);
  });
}
