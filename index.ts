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
  restoreUserRights,
} from "./src/lib.ts";
import { classifyMessageOpenAI } from "./src/openaiClassifier.ts";

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

const goodCitizens = bloom.BloomFilter.create(1000000, 0.01);

// Store allowed threads for links (in memory cache)
const allowedThreads = new Set<string>();

// Load allowed threads from database on startup
const allowedThreadsCollection = mongo.db("family").collection("allowed_threads");
const loadedThreads = await allowedThreadsCollection.find({}).toArray();
loadedThreads.forEach((thread) => allowedThreads.add(thread.threadId));

bot.use(async (ctx, next) => {
  const boosted = await boostedChannel(ctx);
  const family = FAMILY.includes(ctx.message?.from?.username);
  const id = ctx.message?.from?.id;

  console.log(`${id}: me ${isMe(ctx)}, boosted ${boosted}, family ${family}`);

  if (isMe(ctx) || family) return; // stop processing

  // Store boosted status for later middleware
  ctx.state = ctx.state || {};
  ctx.state.boosted = boosted;

  return next();
});
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

// Command handler for allowing links in a thread
bot.command("allowlinks", async (ctx) => {
  // Check if the message is a reply (in a thread)
  const threadId = ctx.message.reply_to_message?.message_id;
  if (!threadId) {
    await ctx.reply("Эта команда должна быть отправлена в ответ на сообщение в треде.");
    return;
  }
  
  // Check if user is admin
  const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
  if (member.status !== "administrator" && member.status !== "creator") {
    await ctx.reply("Только администраторы могут использовать эту команду.");
    return;
  }
  
  const threadKey = `${ctx.chat.id}:${threadId}`;
  allowedThreads.add(threadKey);
  
  // Save to database
  await allowedThreadsCollection.updateOne(
    { threadId: threadKey },
    { $set: { threadId: threadKey, chatId: ctx.chat.id, messageId: threadId } },
    { upsert: true }
  );
  
  await ctx.reply("Ссылки разрешены в этом треде.");
});

bot.command("blocklinks", async (ctx) => {
  // Check if the message is a reply (in a thread)
  const threadId = ctx.message.reply_to_message?.message_id;
  if (!threadId) {
    await ctx.reply("Эта команда должна быть отправлена в ответ на сообщение в треде.");
    return;
  }
  
  // Check if user is admin
  const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
  if (member.status !== "administrator" && member.status !== "creator") {
    await ctx.reply("Только администраторы могут использовать эту команду.");
    return;
  }
  
  const threadKey = `${ctx.chat.id}:${threadId}`;
  allowedThreads.delete(threadKey);
  
  // Remove from database
  await allowedThreadsCollection.deleteOne({ threadId: threadKey });
  
  await ctx.reply("Ссылки заблокированы в этом треде.");
});

bot.on(message("text"), async (ctx, next) => {
  console.debug("hasLinks", hasLinks(ctx));
  if (!hasLinks(ctx)) return next();

  // Check if links are allowed in this thread
  const threadId = ctx.message.reply_to_message?.message_id;
  if (threadId) {
    const threadKey = `${ctx.chat.id}:${threadId}`;
    if (allowedThreads.has(threadKey)) {
      return next();
    }
  }

  // Boosted users can post links
  if (ctx.state?.boosted) return next();

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
  boostsCache.set([ctx.chat.id, userId], true);
});

bot.on("removed_chat_boost", (ctx) => {
  console.log("removed_chat_boost", JSON.stringify(ctx.update));
  const userId = ctx.update.removed_chat_boost.source.user?.id;
  blockUser(ctx.telegram, ctx.chat.id, userId);
  boostsCache.set([ctx.chat.id, userId], false);
});

// Delete media messages
bot.on(
  anyOf(
    message(
      "photo",
      "video",
      "document",
      "audio",
      "voice",
      "video_note",
      "animation",
      "poll",
      "sticker",
      "location",
      "venue",
      "contact",
      "game",
      "video_note"
    )
  ),
  async (ctx) => {
    // Boosted users can post media
    if (ctx.state?.boosted) return;
    
    deleteMediaMessage(ctx);
    return;
  }
);

const launchOptions =
  typeof WEBHOOK_URL === "string"
    ? { webhook: { domain: WEBHOOK_URL } }
    : { polling: { timeout: 30, limit: 10 } };

bot.launch(
  {
    ...launchOptions,
    allowedUpdates: [
      "chat_member",
      "message",
      "edited_message",
      "callback_query",
    ],
  },
  () => console.log("BOT STARTED")
);

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

function isMe({ message }) {
  if (!message || !message.from) return false;

  return (
    message.from.first_name === "Telegram" ||
    (message.from.first_name === "Channel" &&
      myChannels.includes(message.sender_chat?.username))
  );
}
function isChannelBot({ message }) {
  if (!message || !message.from) return false;
  return message.from.first_name === "Channel";
}
function hasLinks(ctx) {
  if (!ctx.message) return false;
  return ctx.message.entities?.some(
    (entity) => entity.type === "url" || entity.type === "text_link"
  );
}
async function boostedChannel(ctx) {
  if (!ctx.hasOwnProperty("message")) return false;

  const userId = ctx.message.from?.id;
  if (!userId) return false;

  const channelId =
    ctx.message.reply_to_message?.sender_chat?.id || "@seniorsoftwarevlogger";

  const chacheHit = boostsCache.get([channelId, userId]);
  if (chacheHit !== undefined) return chacheHit;

  const boostsById = (await ctx.telegram
    .getUserChatBoosts(channelId, userId)
    .catch((e) => console.log(e))) || { boosts: [] };

  const boosted = !!boostsById.boosts?.some(
    (b) => b.expiration_date * 1000 > Date.now()
  );

  boostsCache.set([channelId, userId], boosted);

  return boosted;
}
