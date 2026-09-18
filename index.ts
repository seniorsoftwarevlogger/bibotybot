import { init } from "@sentry/node";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import bloom from "bloom-filters";
import { Telegraf } from "telegraf";
import { anyOf, message } from "telegraf/filters";
import fs from "fs";
import { setupErrorHandler } from "./src/errors.ts";
import {
  blockUser,
  deleteMediaMessage,
  deleteMessage,
  deleteUserReaction,
  muteFor24h,
  restoreUserRights,
} from "./src/lib.ts";
import { classifyMessageOpenAI } from "./src/openaiClassifier.ts";
import { initSpamShadow, logSpamShadow } from "./src/spamShadow.ts";
import { initPromote, rememberUser, setupPromote } from "./src/promote.ts";
import {
  getLevel,
  getRank,
  initPermissions,
  type Rank,
  THRESHOLDS,
} from "./src/permissions.ts";
import {
  boostCacheKey,
  hasLinks,
  isChannelBot,
  isMe,
  isOwnChannelExternalReply,
  isPromoteCommand,
  isStatCommand,
  isTelegramServiceUser,
} from "./src/helpers.ts";

// Setup =======================================================================

dotenv.config();

if (process.env.SENTRY_DSN) {
  init({ dsn: process.env.SENTRY_DSN });
}
setupErrorHandler();

const {
  ME = "",
  BOT_TOKEN = "",
  WEBHOOK_URL = null,
  MONGODB_URI = "",
} = process.env;

const mongo = new MongoClient(MONGODB_URI);
await mongo.connect();

// Read message counters from achivator bot's database (same cluster). Levels
// granted by admins via /promote live in our own database from MONGODB_URI.
initPermissions(mongo.db("achivator_bot"), mongo.db());
initPromote(mongo.db());

// Store Jev shadow-mode comparisons for offline evaluation. Defaults to the
// database from MONGODB_URI, the only one this user is allowed to write to.
initSpamShadow(mongo.db(process.env.JEV_SHADOW_DB));

// const storage = new natural.StorageBackend(natural.STORAGE_TYPES.MONGODB);

// const classifier = await new Promise((resolve, reject) => {
//   natural.BayesClassifier.loadFrom(
//     "classifier",
//     // @ts-expect-error: Ignoring type errors due to incorrect library type definitions
//     natural.PorterStemmerRu,
//     storage,
//     (err, loadedClassifier) => {
//       if (err) {
//         console.error("Ошибка при загрузке модели:", err);
//         reject(err);
//       } else if (loadedClassifier) {
//         console.log("Модель успешно загружена.");
//         resolve(loadedClassifier);
//       } else {
//         console.error("Странная третья опция");
//         reject(new Error("Странная третья опция"));
//       }
//     }
//   );
// }).catch((error) => {
//   console.error("Ошибка при загрузке модели:", error);
// });

// Main ========================================================================

const bot = new Telegraf(BOT_TOKEN, {
  telegram: { webhookReply: !!WEBHOOK_URL },
});
bot.catch((error) => {
  console.error(error);
});

// After bot.catch and before other middleware
bot.use(async (ctx, next) => {
  // Check if it's a private/direct message
  if (ctx.chat?.type === "private") {
    await ctx.reply(
      `Debug info:\n\`\`\`json\n${JSON.stringify(ctx.update, null, 2)}\`\`\``,
      {
        parse_mode: "Markdown",
      }
    );
  }
  return next();
});

const myChannels = ME.split(",");
let FAMILY = await mongo
  .db("family")
  .collection("users")
  .find({})
  .toArray()
  .then((users) => users.map((user) => user.username));

setInterval(async () => {
  FAMILY = await mongo
    .db("family")
    .collection("users")
    .find({})
    .toArray()
    .then((users) => users.map((user) => user.username));
}, 1000 * 60 * 60);

const boostsCache = new Map();
const assignedRanks = new Map<string, Rank>();

const goodCitizens = bloom.BloomFilter.create(1000000, 0.01);

function applyRankTag(chatId: number, userId: number, rank: Rank) {
  const rankKey = `${chatId}:${userId}`;
  if (assignedRanks.get(rankKey) === rank) return;
  assignedRanks.set(rankKey, rank);
  (bot.telegram as any)
    .callApi("setChatMemberTag", { chat_id: chatId, user_id: userId, tag: rank ?? "" })
    .catch((error: unknown) => {
      console.error(`Failed to set rank tag "${rank}" for user ${userId} in chat ${chatId}:`, error);
    });
}

bot.use(async (ctx, next) => {
  const boosted = await boostedChannel(ctx);
  const family = FAMILY.includes(ctx.message?.from?.username);
  const id = ctx.message?.from?.id;
  const chatId = ctx.chat?.id;

  const level =
    id && chatId && ctx.message ? await getLevel(chatId, id) : null;

  console.log(
    `${id}: me ${isMe(ctx, myChannels)}, boosted ${boosted}, family ${family}, messages ${
      level?.messageCount ?? "n/a"
    }, react ${level?.canReact ?? "n/a"}, link ${
      level?.canLink ?? "n/a"
    }, media ${level?.canMedia ?? "n/a"}`
  );

  rememberUser(ctx.message?.from);

  if (
    (isMe(ctx, myChannels) || family) &&
    !isStatCommand(ctx) &&
    !isPromoteCommand(ctx)
  )
    return; // stop processing

  ctx.state = ctx.state || {};
  ctx.state.boosted = boosted;

  if (level) {
    ctx.state.level = level;

    const rank = getRank(level.messageCount);
    if (rank !== null) applyRankTag(chatId, id, rank);
  }

  return next();
});

// Before the channel-post filter, so admins can /promote while posting as the channel.
setupPromote(bot, { myChannels, applyRankTag });

bot.use(async (ctx, next) => {
  console.debug("isChannelBot", isChannelBot(ctx));
  if (!isChannelBot(ctx)) return next();

  // Boosted users can post as channels
  if (ctx.state?.boosted) return next();

  deleteMessage(
    ctx,
    `Под каналом писать нельзя \nТекст поста перемещен в крантин @ssv_purge`
  );
});
bot.use(async (ctx, next) => {
  if (!ctx.message || !("external_reply" in ctx.message)) return next();
  if (isOwnChannelExternalReply(ctx, myChannels)) return next();

  deleteMessage(ctx, "Сообщение с внешней ссылкой удалено.");
});

async function replyWithStat(ctx) {
  const replyTarget = ctx.message.reply_to_message?.from;
  if (replyTarget && isTelegramServiceUser(replyTarget)) {
    await replyAndDeleteStat(
      ctx,
      "В комментариях к посту Telegram не передает боту пользователя, для которого нужно показать статистику. Напишите /stat в чате или ответьте командой на сообщение пользователя в чате."
    );
    return;
  }

  const target = replyTarget ?? ctx.from;
  if (!target) {
    await replyAndDeleteStat(ctx, "Не могу определить пользователя.");
    return;
  }

  const level = await getLevel(ctx.chat.id, target.id);
  const boosted = await boostedUser(ctx.telegram, ctx.message, target.id);
  const family = Boolean(target.username && FAMILY.includes(target.username));
  const name = target.username ? `@${target.username}` : target.first_name;
  const rank = getRank(level.messageCount);
  const manual = level.override !== null && level.override > level.realMessageCount;

  await replyAndDeleteStat(
    ctx,
    [
      `Статистика ${name}:`,
      `Сообщений: ${level.realMessageCount}`,
      `Ранг: ${rank ?? "—"}${manual ? " (назначен админом)" : ""}`,
      `Реакции: ${level.canReact ? "можно" : `нужно ${THRESHOLDS.react}`}`,
      `Ссылки: ${level.canLink ? "можно" : `нужно ${THRESHOLDS.link}`}`,
      `Медиа: ${level.canMedia ? "можно" : `нужно ${THRESHOLDS.media}`}`,
      `Буст: ${boosted ? "есть" : "нет"}`,
      `Family: ${family ? "да" : "нет"}`,
    ].join("\n")
  );
}

async function replyAndDeleteStat(ctx, text) {
  const botReply = await ctx.reply(text, {
    reply_parameters: {
      message_id: ctx.message.message_id,
    },
  });

  setTimeout(() => {
    ctx.deleteMessage(botReply.message_id).catch((error) => {
      console.log("CANT DELETE STAT REPLY:", botReply, error);
    });
  }, 15000);
}

bot.command("stat", replyWithStat);
bot.hears(/^@bibotybot\/stat(?:\s|$)/i, replyWithStat);

bot.on(message("text"), async (ctx, next) => {
  console.debug("hasLinks", hasLinks(ctx));
  if (!hasLinks(ctx)) return next();

  // Boosted users and users who earned enough messages can post links
  if (ctx.state?.boosted) return next();
  if (ctx.state?.level?.canLink) return next();

  const messageCount = ctx.state?.level?.messageCount ?? 0;
  if (messageCount >= THRESHOLDS.react) {
    // active member, just shy of the link threshold — soft delete, no mute
    deleteMessage(
      ctx,
      `Ссылки доступны после ${THRESHOLDS.link} сообщений. У вас ${messageCount}.`,
      { mute: false }
    );
    return;
  }

  deleteMessage(
    ctx,
    "Ссылки за буст канала https://t.me/boost/seniorsoftwarevlogger " +
      "или за доллар https://boosty.to/seniorsoftwarevlogger " +
      "\nТекст поста перемещен в карантин @ssv_purge"
  );
  return;
});

// Replace the existing isSpam function with this one
async function isSpam(text: string): Promise<boolean> {
  return await classifyMessageOpenAI(text);
}

bot.on(message("text"), async (ctx, next) => {
  // delete if the message has a lots of custom emojis
  if (ctx.message.entities?.some((entity) => entity.type === "custom_emoji")) {
    const emojis = ctx.message.entities
      .filter((entity) => entity.type === "custom_emoji")
      .map((entity) => entity.custom_emoji_id);

    if (emojis.length > 5) {
      deleteMessage(ctx, "Сообщение содержит много эмодзи, удалено.");
      return;
    }
  }
  return next();
});

// Update the middleware for spam filtering
bot.on(message("text"), async (ctx, next) => {
  if (goodCitizens.has(ctx.message.from.id.toString())) {
    // check if the bloom filter has the user id, means that the user posted a message that was classified as not spam
    return next();
  }

  const spam = await isSpam(ctx.message.text);

  // Shadow mode: ask Jev the same question, log only, decision stays with OpenAI.
  logSpamShadow({
    text: ctx.message.text,
    chatId: ctx.chat.id,
    userId: ctx.message.from.id,
    messageId: ctx.message.message_id,
    production: spam,
  });

  if (!spam) {
    goodCitizens.add(ctx.message.from.id.toString());

    return next();
  }
  blockUser(ctx.telegram, ctx.chat.id, ctx.message.from.id).catch((error) => {
    console.error("Error blocking user:", error);
  });
  deleteMessage(ctx, "Сообщение похожее на спам было удалено.");

  return;

  await ctx.reply(
    "Это сообщение похоже на спам. Если это спам, нажмите кнопку, чтобы удалить его даже если вы не админ.",
    {
      reply_parameters: {
        message_id: ctx.message.message_id,
      },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Голос за удаление",
              callback_data: `del:${ctx.message.message_id}:${ctx.chat.id}:${ctx.from.id}:`,
            },
          ],
        ],
      },
    }
  );
});

// Handle the delete button callback
bot.action(/del:/, async (ctx) => {
  if (!ctx.callbackQuery || !("data" in ctx.callbackQuery)) return;
  const [action, messageId, chatId, userId, votes] =
    ctx.callbackQuery.data.split(":");

  const filteredVotes = votes.split(",").filter((vote) => vote.trim() !== "");

  const votesParsed = Array.from(
    new Set([...filteredVotes, ctx.callbackQuery.from.id.toString()])
  );

  if (votesParsed.length >= 3) {
    try {
      await ctx.telegram.copyMessage("@ssv_purge", chatId, parseInt(messageId));
      // todo: add to the classifier store

      await ctx.deleteMessage(parseInt(messageId));
      if (ctx.callbackQuery.message?.message_id)
        await ctx.deleteMessage(ctx.callbackQuery.message?.message_id);
      await ctx.answerCbQuery("Сообщение удалено.");
    } catch (error) {
      console.error("Error deleting message:", error);
      await ctx.answerCbQuery("Не удалось удалить сообщение.");
    }
  } else {
    // edit message to show current votes
    await ctx.editMessageText(
      `Это сообщение похоже на спам. Если это спам, проголосуйте, чтобы удалить его даже если вы не админ. 
      
Проголосовали: ${votesParsed.join(", ")}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `Голосов за удаление: ${votesParsed.length}/3`,
                callback_data: `del:${messageId}:${chatId}:${userId}:${votesParsed.join(
                  ","
                )}`,
              },
            ],
          ],
        },
      }
    );
  }
});

const CLOWN_REACTION = "🤡";

// Repeat early-reaction within this window escalates from "just delete" to a mute.
const REACTION_STRIKE_WINDOW_MS = 60 * 60 * 1000;
const reactionStrikes = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [key, expiresAt] of reactionStrikes) {
    if (expiresAt <= now) reactionStrikes.delete(key);
  }
}, 10 * 60 * 1000);

function isClownReaction(reaction: { type: string; emoji?: string }) {
  return reaction.type === "emoji" && reaction.emoji === CLOWN_REACTION;
}

bot.on("message_reaction", async (ctx) => {
  const upd = ctx.update.message_reaction;
  const userId = upd.user?.id;
  if (!userId) return; // anonymous channel reactions are not attributed to a user

  if (upd.user?.username && FAMILY.includes(upd.user.username)) return;

  const chatId = upd.chat.id;
  const oldReactions = upd.old_reaction || [];
  const newReactions = upd.new_reaction || [];

  const hadClownReaction = oldReactions.some(isClownReaction);
  const addedClownReaction =
    !hadClownReaction && newReactions.some(isClownReaction);

  if (addedClownReaction) {
    console.log(
      `Clown reaction trap: muting user ${userId} in chat ${chatId} for 24 hours`
    );
    await muteFor24h(ctx.telegram, chatId, userId).catch((error) => {
      console.error(
        `Failed to mute user ${userId} for clown reaction trap:`,
        error
      );
    });
    return;
  }

  // Reactions are gated behind a small message threshold to keep bot reaction
  // farms out. First strike: silently remove the reaction. Repeat within the
  // strike window: 24h mute on top.
  const reactionAdded = newReactions.length > oldReactions.length;
  if (!reactionAdded) return;

  const level = await getLevel(chatId, userId);
  if (level.canReact) return;

  const messageId = upd.message_id;
  await deleteUserReaction(ctx.telegram, chatId, messageId, userId).catch(
    (error) => {
      console.error(
        `Failed to delete reaction by user ${userId} on message ${messageId}:`,
        error
      );
    }
  );

  const strikeKey = `${chatId}:${userId}`;
  const now = Date.now();
  const previousStrike = reactionStrikes.get(strikeKey);
  const isRepeat = previousStrike !== undefined && previousStrike > now;

  if (isRepeat) {
    console.log(
      `Reaction gate: muting repeat offender ${userId} in chat ${chatId} (${level.messageCount}/${THRESHOLDS.react} messages)`
    );
    reactionStrikes.delete(strikeKey);
    await muteFor24h(ctx.telegram, chatId, userId).catch((error) => {
      console.error(
        `Failed to mute user ${userId} for repeat early reaction:`,
        error
      );
    });
    return;
  }

  reactionStrikes.set(strikeKey, now + REACTION_STRIKE_WINDOW_MS);
  console.log(
    `Reaction gate: removed reaction by ${userId} in chat ${chatId} (${level.messageCount}/${THRESHOLDS.react} messages, first strike)`
  );
});

// Replicate ban across all chats
bot.on("chat_member", async (ctx) => {
  if (ctx.update.chat_member?.new_chat_member?.status === "kicked") {
    const bannedFrom = ctx.update.chat_member.chat.id;
    const adminId = ctx.update.chat_member.from?.id;
    const userId = ctx.update.chat_member.new_chat_member.user.id;
    const chats = Object.values({
      "@seniorsoftwarevlogger": 1419874945,
      "@teamleadtalks": 1312934916,
    }).filter((id) => id !== bannedFrom);

    for (const chat of chats) {
      await ctx.telegram.banChatMember(chat, userId).catch((error) => {
        console.error(`Failed to ban user ${userId} in chat ${chat}:`, error);
      });
    }

    console.log(`${adminId} banned ${userId} from ${chats}`);
  }
});

bot.on("chat_boost", (ctx) => {
  console.log("chat_boost", JSON.stringify(ctx.update));
  const userId = ctx.update.chat_boost.boost.source.user?.id;
  restoreUserRights(ctx.telegram, ctx.chat.id, userId);
  boostsCache.set(boostCacheKey(ctx.chat.id, userId), true);
});

bot.on("removed_chat_boost", (ctx) => {
  console.log("removed_chat_boost", JSON.stringify(ctx.update));
  const userId = ctx.update.removed_chat_boost.source.user?.id;
  blockUser(ctx.telegram, ctx.chat.id, userId);
  boostsCache.set(boostCacheKey(ctx.chat.id, userId), false);
});

// Delete media messages
bot.on(
  anyOf(
    message("photo"),
    message("video"),
    message("document"),
    message("audio"),
    message("voice"),
    message("video_note"),
    message("animation"),
    message("poll"),
    message("sticker"),
    message("location"),
    message("venue"),
    message("contact"),
    message("game")
  ),
  async (ctx) => {
    if (ctx.state?.boosted) return;
    if (ctx.state?.level?.canMedia) return;

    const messageCount = ctx.state?.level?.messageCount ?? 0;
    if (messageCount >= THRESHOLDS.react) {
      deleteMediaMessage(ctx, {
        mute: false,
        warning: `Медиа доступны после ${THRESHOLDS.media} сообщений. У вас ${messageCount}.`,
      });
      return;
    }

    deleteMediaMessage(ctx);
    return;
  }
);

const launchOptions =
  typeof WEBHOOK_URL === "string"
    ? { webhook: { domain: WEBHOOK_URL } }
    : { polling: { timeout: 30, limit: 10 } };

await bot.telegram
  .setMyCommands([{ command: "stat", description: "show user stats" }])
  .catch((error) => console.error("Failed to set bot commands:", error));
await bot.telegram
  .setMyCommands(
    [
      { command: "stat", description: "show user stats" },
      { command: "promote", description: "назначить уровень: /promote @username" },
    ],
    { scope: { type: "all_chat_administrators" } }
  )
  .catch((error) => console.error("Failed to set admin commands:", error));

bot.launch(
  {
    ...launchOptions,
    allowedUpdates: [
      "chat_member",
      "message",
      "edited_message",
      "callback_query",
      "message_reaction",
    ],
  },
  () => console.log("BOT STARTED")
);

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

async function boostedChannel(ctx) {
  if (!ctx.hasOwnProperty("message")) return false;

  const userId = ctx.message.from?.id;
  if (!userId) return false;

  return boostedUser(ctx.telegram, ctx.message, userId);
}

async function boostedUser(telegram, message, userId) {
  const channelId =
    message.reply_to_message?.sender_chat?.id || "@seniorsoftwarevlogger";
  const cacheKey = boostCacheKey(channelId, userId);

  const cacheHit = boostsCache.get(cacheKey);
  if (cacheHit !== undefined) return cacheHit;

  const boostsById = (await telegram
    .getUserChatBoosts(channelId, userId)
    .catch((e) => console.log(e))) || { boosts: [] };

  const boosted = !!boostsById.boosts?.some(
    (b) => b.expiration_date * 1000 > Date.now()
  );

  boostsCache.set(cacheKey, boosted);

  return boosted;
}
