import { Telegraf } from "telegraf";
import i18n from "i18n";
import { init } from "@sentry/node";
import { MongoClient } from "mongodb";
import { fileURLToPath } from "url";
import { dirname } from "path";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Setup =======================================================================

i18n.configure({
  defaultLocale: "ru",
  locales: ["ru", "en"],
  directory: __dirname + "/locales",
});

const isProduction = process.env.NODE_ENV === "production";

if (!isProduction) {
  dotenv.config();
}

if (process.env.SENTRY_DSN) {
  init({ dsn: process.env.SENTRY_DSN });
}

const missingEnv = ["ME", "PORT", "BOT_TOKEN", "WEBHOOK_URL", "MONGODB_URI"].filter((e) => !process.env[e]);

const { ME, PORT, BOT_TOKEN, WEBHOOK_URL } = process.env;

if (isProduction && missingEnv.length > 0) {
  console.error("Missing ENV var:", missingEnv.join(", "));
  process.exit(1);
}

const mongo = new MongoClient(process.env.MONGODB_URI);
await mongo.connect();
// Main ========================================================================

const bot = new Telegraf(BOT_TOKEN, {
  telegram: {
    webhookReply: isProduction,
  },
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

function isMe({ message }) {
  return (
    message.from.first_name === "Telegram" ||
    (message.from.first_name === "Channel" && myChannels.includes(message.sender_chat?.username))
  );
}
function isChannelBot({ message }) {
  return message.from.first_name === "Channel";
}
function hasLink(ctx) {
  return ctx.message.entities?.some((entity) => entity.type === "url" || entity.type === "text_link");
}

const spamChecks = [isChannelBot, hasLink];

// New functionality to handle ban events and replicate them across all channels
bot.on("chat_member", async (ctx) => {
  // Check if the update is a ban event and if the user issuing the ban is an admin
  if (ctx.update.chat_member.new_chat_member.status === "kicked" && myChannels.includes(ctx.from.username)) {
    const userId = ctx.update.chat_member.from.id;

    // Replicate the ban across all channels managed by the bot
    for (const channel of myChannels) {
      await ctx.telegram.banChatMember(channel, userId).catch((error) => {
        console.error(`Failed to ban user ${userId} in channel ${channel}:`, error);
      });
    }

    ctx.reply(`User ${userId} has been banned from all managed channels.`);
  }
});

bot.on("message", (ctx) => {
  if (isMe(ctx) || family.includes(ctx.message.from.username)) return;

  const replyToChannelId =
    ctx.message.reply_to_message?.sender_chat && ctx.message.reply_to_message?.from.first_name === "Telegram"
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
            `💸 Купи стикеры, @${ctx.message.from.username}: https://boosty.to/seniorsoftwarevlogger`,
            { disable_web_page_preview: true, reply_to_message_id: replyToChannelId }
          )
          .then((botReply) => {
            setTimeout(() => ctx.deleteMessage(botReply.message_id), 10000);
          });

        ctx.restrictChatMember(ctx.message.from.id, {
          permissions: {
            can_send_messages: true,
            can_send_media_messages: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
            can_change_info: false,
            can_invite_users: false,
            can_pin_messages: false,
          },
        });
      })
      .catch((e) => console.log("CANT DELETE:", ctx.message, e));
  }

  // Delete links
  if (spamChecks.some((check) => check(ctx))) {
    ctx.telegram
      .sendMessage(
        ctx.chat.id,
        `💸 Купи ссылки, @${ctx.message.from.username}: https://boosty.to/seniorsoftwarevlogger \nТекст поста перемещен в карантин @ssv_purge`,
        { disable_web_page_preview: true, reply_to_message_id: replyToChannelId }
      )
      .then((botReply) => {
        setTimeout(() => ctx.deleteMessage(botReply.message_id), 60000);
      });

    return ctx.telegram
      .copyMessage(`@ssv_purge`, ctx.chat.id, ctx.message.message_id, { disable_notification: true })
      .then((res) =>
        ctx.deleteMessage(ctx.message.message_id).catch((e) => console.log("CANT DELETE:", ctx.message, e))
      );
  }
});

const botOptions = isProduction
  ? {
      webhook: {
        domain: WEBHOOK_URL,
        port: parseInt(PORT, 10),
      },
      allowedUpdates: ["chat_member", "message", "edited_message"]
    }
  : {
      polling: { timeout: 30, limit: 10 },
    };

bot.launch(botOptions);

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
