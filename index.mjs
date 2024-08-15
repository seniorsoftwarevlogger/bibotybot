import { Telegraf } from "telegraf";
import { init } from "@sentry/node";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

// Setup =======================================================================

dotenv.config();

if (process.env.SENTRY_DSN) {
  init({ dsn: process.env.SENTRY_DSN });
}

const { ME, BOT_TOKEN, WEBHOOK_URL } = process.env;

const mongo = new MongoClient(process.env.MONGODB_URI);
await mongo.connect();
// Main ========================================================================

const bot = new Telegraf(BOT_TOKEN, {
  telegram: { webhookReply: !!WEBHOOK_URL },
});

const myChannels = ME.split(",");
let family = await mongo
  .db("family")
  .collection("users")
  .find({})
  .toArray()
  .then((users) => users.map((user) => user.username));

setInterval(async () => {
  family = await mongo
    .db("family")
    .collection("users")
    .find({})
    .toArray()
    .then((users) => users.map((user) => user.username));
}, 1000 * 60 * 60);

const boostsCache = new Map();

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
  const channelId =
    ctx.message.reply_to_message?.sender_chat?.id || "@seniorsoftwarevlogger";
  const boostsById = (await ctx.telegram
    .getUserChatBoosts(channelId, ctx.message.from.id)
    .catch((e) => console.log(e))) || { boosts: [] };

  return !!boostsById.boosts?.some(
    (b) => new Date(b.expiration_date * 1000) > Date.now()
  );
}

// New functionality to handle ban events and replicate them across all channels
bot.on("chat_member", async (ctx) => {
  // Check if the update is a ban event and if the user issuing the ban is an admin
  if (
    ctx.update.chat_member.new_chat_member.status === "kicked" &&
    myChannels.includes(ctx.from.username)
  ) {
    const userId = ctx.update.chat_member.from.id;

    // Replicate the ban across all channels managed by the bot
    for (const channel of myChannels) {
      await ctx.telegram.banChatMember(channel, userId).catch((error) => {
        console.error(
          `Failed to ban user ${userId} in channel ${channel}:`,
          error
        );
      });
    }

    ctx.reply(`User ${userId} has been banned from all managed channels.`);
  }
});

bot.on("chat_boost", (ctx) => {
  console.log("chat_boost", JSON.stringify(ctx.update));
});

bot.on("removed_chat_boost", (ctx) => {
  console.log("removed_chat_boost", JSON.stringify(ctx.update));
});

bot.on("message", async (ctx) => {
  const isBoosted =
    boostsCache.get(ctx.message.from.id) || (await boostedChannel(ctx));
  if (isBoosted) boostsCache.set(ctx.message.from.id, isBoosted);

  console.log(
    `id`,
    ctx.message.from.id,
    `isMe`,
    isMe(ctx),
    `isBoosted`,
    isBoosted,
    `family`,
    family.includes(ctx.message.from.username)
  );

  if (isMe(ctx) || isBoosted || family.includes(ctx.message.from.username))
    return;

  const replyToChannelId =
    ctx.message.reply_to_message?.sender_chat &&
    ctx.message.reply_to_message?.from.first_name === "Telegram"
      ? ctx.message.reply_to_message.message_id
      : null;

  // Delete media messages
  if (!ctx.message.text) {
    // block user from sending media
    return ctx
      .deleteMessage(ctx.message.message_id)
      .then(() => {
        ctx.telegram
          .sendMessage(
            ctx.chat.id,
            `Медиа за буст канала https://t.me/boost/seniorsoftwarevlogger или за доллар https://boosty.to/seniorsoftwarevlogger`,
            {
              disable_web_page_preview: true,
              reply_to_message_id: replyToChannelId,
            }
          )
          .then((botReply) => {
            setTimeout(() => ctx.deleteMessage(botReply.message_id), 10000);
          });

        // ctx.restrictChatMember(ctx.message.from.id, {
        //   permissions: {
        //     can_send_messages: true,
        //     can_send_media_messages: false,
        //     can_send_polls: false,
        //     can_send_other_messages: false,
        //     can_add_web_page_previews: false,
        //     can_change_info: false,
        //     can_invite_users: false,
        //     can_pin_messages: false,
        //   },
        // });
      })
      .catch((e) => console.log("CANT DELETE:", ctx.message, e))
      .finally(() => console.log("DELETED", ctx.message.message_id));
  }

  // Delete links
  if (hasLinks(ctx)) {
    ctx.telegram
      .sendMessage(
        ctx.chat.id,
        `Ссылки за буст канала https://t.me/boost/seniorsoftwarevlogger или за доллар https://boosty.to/seniorsoftwarevlogger \nТекст поста перемещен в карантин @ssv_purge`,
        {
          disable_web_page_preview: true,
          reply_to_message_id: replyToChannelId,
        }
      )
      .then((botReply) => {
        setTimeout(() => ctx.deleteMessage(botReply.message_id), 60000);
      });

    return ctx.telegram
      .copyMessage(`@ssv_purge`, ctx.chat.id, ctx.message.message_id, {
        disable_notification: true,
        link_preview_options: { is_disabled: true },
      })
      .then((res) =>
        ctx
          .deleteMessage(ctx.message.message_id)
          .catch((e) => console.log("CANT DELETE:", ctx.message, e))
          .finally(() => console.log("DELETED", ctx.message.message_id))
      );
  }
  // Delete channels
  if (isChannelBot(ctx)) {
    ctx.telegram
      .sendMessage(
        ctx.chat.id,
        `Под каналом писать нельзя \nТекст поста перемещен в карантин @ssv_purge`,
        {
          disable_web_page_preview: true,
          reply_to_message_id: replyToChannelId,
        }
      )
      .then((botReply) => {
        setTimeout(() => ctx.deleteMessage(botReply.message_id), 60000);
      });

    return ctx.telegram
      .copyMessage(`@ssv_purge`, ctx.chat.id, ctx.message.message_id, {
        disable_notification: true,
        link_preview_options: { is_disabled: true },
      })
      .then((res) =>
        ctx
          .deleteMessage(ctx.message.message_id)
          .catch((e) => console.log("CANT DELETE:", ctx.message, e))
      );
  }
});

const launchOptions = process.env.WEBHOOK_URL
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
