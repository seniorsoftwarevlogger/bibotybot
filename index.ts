import { init } from "@sentry/node";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { Telegraf } from "telegraf";
import { anyOf, message } from "telegraf/filters";
import { setupErrorHandler } from "./src/errors.ts";
import {
  blockUser,
  deleteMediaMessage,
  deleteMessage,
  restoreUserRights,
} from "./src/lib.ts";

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
// Main ========================================================================

const bot = new Telegraf(BOT_TOKEN, {
  telegram: { webhookReply: !!WEBHOOK_URL },
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

bot.use(async (ctx, next) => {
  const boosted = await boostedChannel(ctx);
  const family = FAMILY.includes(ctx.message?.from?.username);
  const id = ctx.message?.from?.id;

  console.log(`${id}: me ${isMe(ctx)}, boosted ${boosted}, family ${family}`);

  if (isMe(ctx) || boosted || family) return; // stop processing

  return next();
});
bot.use(async (ctx, next) => {
  console.debug("isChannelBot", isChannelBot(ctx));
  if (!isChannelBot(ctx)) return next();

  deleteMessage(
    ctx,
    `Под каналом писать нельзя \nТекст поста перемещен в карантин @ssv_purge`
  );
});
bot.on(message("text"), async (ctx, next) => {
  console.debug("hasLinks", hasLinks(ctx));
  if (!hasLinks(ctx)) return next();

  deleteMessage(
    ctx,
    "Ссылки за буст канала https://t.me/boost/seniorsoftwarevlogger " +
      "или за доллар https://boosty.to/seniorsoftwarevlogger " +
      "\nТекст поста перемещен в карантин @ssv_purge"
  );
  return;
});

// Replicate ban across all chats
bot.on("chat_member", async (ctx) => {
  if (ctx.update.chat_member?.new_chat_member?.status === "kicked") {
    const bannedFrom = ctx.update.chat_member.chat.id;
    const adminId = ctx.update.chat_member.from.id;
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
    allowedUpdates: ["chat_member", "message", "edited_message"],
  },
  () => console.log("BOT STARTED")
);

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

function isMe({ message }) {
  return (
    message.from.first_name === "Telegram" ||
    (message.from.first_name === "Channel" &&
      myChannels.includes(message.sender_chat?.username))
  );
}
function isChannelBot({ message }) {
  return message.from.first_name === "Channel";
}
function hasLinks(ctx) {
  return ctx.message.entities?.some(
    (entity) => entity.type === "url" || entity.type === "text_link"
  );
}
async function boostedChannel(ctx) {
  if (!ctx.hasOwnProperty("message")) return false;

  const userId = ctx.message.from.id;
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
