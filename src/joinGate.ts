import type { Telegraf } from "telegraf";
import { blockUserUntil, deleteMessage, unbanUser } from "./lib.ts";
import { THRESHOLDS } from "./permissions.ts";
import { isAdmin } from "./promote.ts";

// Join gate for channel discussion groups. Commenting under a channel post
// silently adds the subscriber to the linked discussion group, and such
// members never open the group itself — a captcha posted to the group's main
// chat would be invisible to them. So the gate only arms on the join (the
// chat_member update or the new_chat_members service message) and fires on
// the member's first message: the message is quarantined, the captcha is
// posted as a reply in the same thread (visible in the channel's comment UI,
// where inline buttons work), and the member is restricted until they press
// "Я не бот". The restriction self-expires, so a crash can never leave anyone
// muted forever; a member who never writes is never touched at all.

export const JOIN_GATE_PREFIX = "joingate";

const DEFAULT_FRESH_JOIN_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_RESTRICTION_TTL_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const PASS_CONFIRM_TTL_MS = 60 * 1000;

type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name: string;
  username?: string;
};

type ChatMemberUpdate = {
  chat: { id: number };
  old_chat_member?: { status: string };
  new_chat_member: { status: string; user: TelegramUser };
};

type PendingCaptcha = {
  chatId: number;
  userId: number;
  captchaMessageId: number;
  expiresAt: number;
};

const recentJoins = new Map<string, number>();
const pending = new Map<string, PendingCaptcha>();

// A message the user actually authored; service messages like "X joined the
// group" or "X left" carry no content and must not trigger the captcha.
const CONTENT_FIELDS = [
  "text",
  "caption",
  "photo",
  "video",
  "voice",
  "audio",
  "document",
  "sticker",
  "animation",
  "video_note",
  "poll",
  "dice",
  "contact",
  "location",
  "venue",
  "game",
];

export function joinEvent(
  newStatus: string,
  oldStatus: string | undefined
): "join" | "leave" | "other" {
  if (newStatus === "member" && (oldStatus === "left" || oldStatus === "kicked")) {
    return "join";
  }
  if (newStatus === "left" || newStatus === "kicked") return "leave";
  return "other";
}

export function parseJoinGateCallback(
  data: string
): { chatId: number; userId: number } | null {
  const match = new RegExp(`^${JOIN_GATE_PREFIX}:(-?\\d+):(\\d+)$`).exec(data);
  if (!match) return null;
  return { chatId: Number(match[1]), userId: Number(match[2]) };
}

export function captchaText(chatTitle: string | undefined): string {
  return [
    chatTitle ? `Добро пожаловать в «${chatTitle}»!` : "Добро пожаловать!",
    "",
    "Ваше сообщение удалено и сохранено в карантине: сначала подтвердите, что вы не бот — нажмите кнопку ниже.",
    "",
    "Правила чата:",
    `• реакции — после ${THRESHOLDS.react} сообщений;`,
    `• ссылки — после ${THRESHOLDS.link} сообщений или за буст канала;`,
    `• медиа — после ${THRESHOLDS.media} сообщений;`,
    "• не больше 5 кастомных эмодзи в одном сообщении.",
  ].join("\n");
}

function dropPending(chatId: number, userId: number): PendingCaptcha | undefined {
  const key = `${chatId}:${userId}`;
  const entry = pending.get(key);
  if (entry) pending.delete(key);
  return entry;
}

function isFreshJoiner(chatId: number, userId: number, windowMs: number): boolean {
  const joinedAt = recentJoins.get(`${chatId}:${userId}`);
  return joinedAt !== undefined && Date.now() - joinedAt < windowMs;
}

async function startCaptcha(ctx, restrictionTtlMs: number) {
  const chatId = ctx.chat.id;
  const userId = ctx.message.from.id;
  dropPending(chatId, userId);

  // Reply before removing the held message, so the captcha lands in the same
  // comment thread — the only place a comments-only member will ever look.
  const sent = await ctx.telegram
    .sendMessage(chatId, captchaText(ctx.chat?.title), {
      reply_parameters: {
        message_id: ctx.message.message_id,
        allow_sending_without_reply: true,
      },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Я не бот ✅",
              callback_data: `${JOIN_GATE_PREFIX}:${chatId}:${userId}`,
            },
          ],
        ],
      },
    })
    .catch((error) => {
      console.error(`joinGate: failed to send captcha to ${chatId}:`, error);
      return null;
    });

  // Quarantine and drop the held message; the captcha reply explains why.
  await deleteMessage(ctx, null, { mute: false });

  if (!sent) return;

  const untilDate = Math.floor((Date.now() + restrictionTtlMs) / 1000);
  await blockUserUntil(ctx.telegram, chatId, userId, untilDate).catch((error) => {
    console.error(`joinGate: failed to restrict ${userId} in ${chatId}:`, error);
  });
  pending.set(`${chatId}:${userId}`, {
    chatId,
    userId,
    captchaMessageId: sent.message_id,
    expiresAt: Date.now() + restrictionTtlMs,
  });
  console.log(`joinGate: captcha for user=${userId} chat=${chatId}`);
}

export function setupJoinGate(
  bot: Telegraf,
  {
    myChannels,
    family,
    freshJoinWindowMs = DEFAULT_FRESH_JOIN_WINDOW_MS,
    restrictionTtlMs = DEFAULT_RESTRICTION_TTL_MS,
  }: {
    myChannels: string[];
    family: () => string[];
    freshJoinWindowMs?: number;
    restrictionTtlMs?: number;
  }
) {
  // The message middleware must run before the content gates (links, spam,
  // media), and the chat_member handler before any other chat_member handler
  // that doesn't call next() (ban replication in index.ts). Calling
  // setupJoinGate early in index.ts — after the level middleware it reads
  // from ctx.state — satisfies both.
  bot.use(async (ctx, next) => {
    const message = ctx.message;
    if (!message || !ctx.chat) return next();

    // Joins also arrive as service messages (and can win the race against the
    // chat_member update) — arm the gate from them too.
    if (Array.isArray(message.new_chat_members)) {
      for (const user of message.new_chat_members) {
        if (!user.is_bot) {
          recentJoins.set(`${ctx.chat.id}:${user.id}`, Date.now());
        }
      }
      return next();
    }

    const chatId = ctx.chat.id;
    const user = message.from;
    const userId = user?.id;
    if (!userId || user?.is_bot || message.sender_chat) return next();
    if (!CONTENT_FIELDS.some((field) => field in message)) return next();
    if (user?.username && family().includes(user.username)) return next();

    const key = `${chatId}:${userId}`;
    const activeCaptcha = pending.get(key);
    if (activeCaptcha && activeCaptcha.expiresAt > Date.now()) {
      // An unanswered captcha already sits in the thread — hold this message
      // too, without another reply.
      await deleteMessage(ctx, null, { mute: false });
      return;
    }

    if (!isFreshJoiner(chatId, userId, freshJoinWindowMs)) return next();
    if (ctx.state?.boosted) return next();
    if ((ctx.state?.level?.messageCount ?? 0) >= THRESHOLDS.react) return next();

    await startCaptcha(ctx, restrictionTtlMs);
  });

  bot.on("chat_member", async (ctx, next) => {
    const upd = ctx.update.chat_member as ChatMemberUpdate | undefined;
    if (upd) {
      const user = upd.new_chat_member.user;
      const event = joinEvent(
        upd.new_chat_member.status,
        upd.old_chat_member?.status
      );
      if (event === "join") {
        if (!user.is_bot) {
          recentJoins.set(`${upd.chat.id}:${user.id}`, Date.now());
        }
      } else if (event === "leave") {
        recentJoins.delete(`${upd.chat.id}:${user.id}`);
        const entry = dropPending(upd.chat.id, user.id);
        if (entry) {
          await ctx.telegram
            .deleteMessage(entry.chatId, entry.captchaMessageId)
            .catch(() => {});
        }
      }
    }
    return next();
  });

  bot.action(new RegExp(`^${JOIN_GATE_PREFIX}:`), async (ctx) => {
    if (!ctx.callbackQuery || !("data" in ctx.callbackQuery)) return;
    const parsed = parseJoinGateCallback(ctx.callbackQuery.data);
    if (!parsed) {
      await ctx.answerCbQuery().catch(() => {});
      return;
    }
    const { chatId, userId } = parsed;
    const clicker = ctx.callbackQuery.from;

    // The gated user confirms themselves; anyone else must be an admin.
    if (clicker.id !== userId) {
      const admin = await isAdmin(ctx.telegram, chatId, clicker, undefined, myChannels);
      if (!admin) {
        await ctx.answerCbQuery("Эта кнопка не для вас.");
        return;
      }
    }

    dropPending(chatId, userId);
    // Don't re-gate their next message: the member is verified now.
    recentJoins.delete(`${chatId}:${userId}`);

    // Restoring is idempotent, so this also covers a restart that lost the
    // pending entry while the member was still restricted.
    try {
      await unbanUser(ctx.telegram, chatId, userId);
    } catch (error) {
      console.error(`joinGate: failed to restore ${userId} in ${chatId}:`, error);
    }

    const captchaMessageId = ctx.callbackQuery.message?.message_id;
    await ctx
      .editMessageText("✅ Проверка пройдена. Добро пожаловать!")
      .catch(() => {});
    if (captchaMessageId) {
      setTimeout(() => {
        ctx.telegram
          .deleteMessage(chatId, captchaMessageId)
          .catch((error) =>
            console.log("CANT DELETE JOIN GATE MESSAGE:", captchaMessageId, error)
          );
      }, PASS_CONFIRM_TTL_MS);
    }
    console.log(`joinGate: passed user=${userId} chat=${chatId}`);
    await ctx.answerCbQuery("Добро пожаловать!");
  });

  // Keep the maps bounded and tidy up expired captchas from the threads.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, joinedAt] of recentJoins) {
      if (now - joinedAt >= freshJoinWindowMs) recentJoins.delete(key);
    }
    for (const [key, entry] of pending) {
      if (entry.expiresAt <= now) {
        pending.delete(key);
        bot.telegram
          .deleteMessage(entry.chatId, entry.captchaMessageId)
          .catch(() => {});
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref();
}
