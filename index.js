const { Telegraf } = require("telegraf");
const i18n = require("i18n");
const Sentry = require("@sentry/node");
const { update } = require("lodash");

// Setup =======================================================================

i18n.configure({
  defaultLocale: "ru",
  locales: ["ru", "en"],
  directory: __dirname + "/locales",
});

const isProduction = process.env.NODE_ENV === "production";

if (!isProduction) {
  require("dotenv").config();
}

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN });
}

const missingEnv = [
  "ME",
  "PORT",
  "BOT_TOKEN",
  "WEBHOOK_URL",
  "ALLOW",
  "FAMILY",
].filter((e) => !process.env[e]);

const { ME, PORT, BOT_TOKEN, NODE_ENV, WEBHOOK_URL, ALLOW } = process.env;

if (isProduction && missingEnv.length > 0) {
  console.error("Missing ENV var:", missingEnv.join(", "));
  process.exit(1);
}

// Main ========================================================================

const bot = new Telegraf(BOT_TOKEN, {
  telegram: {
    webhookReply: isProduction,
  },
});

const deletedMessages = [];
const myChannels = ME.split(",");
const allowList = ALLOW.split(",");
const family = FAMILY.split(",");

function isMe({ message }) {
  return (
    message.from.first_name === "Telegram" ||
    (message.from.first_name === "Channel" &&
      myChannels.includes(message.sender_chat?.username))
  );
}
function isAllowList({ message }) {
  return allowList.includes(message.sender_chat?.username);
}
function isChannelBot({ message }) {
  return message.from.first_name === "Channel";
}
function hasTelegramLink(ctx) {
  return ctx.message.text?.includes("t.me");
}

const spamChecks = [isChannelBot, hasTelegramLink];

bot.on("message", (ctx) => {
  console.log(ctx.message.from);

  // test if message is not text and not from family
  if (!ctx.message.text && !family.includes(ctx.message.from.username)) {
    // block user from sending media
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

    ctx
      .deleteMessage(ctx.message.message_id)
      .then(() => deletedMessages.push(ctx.message.message_id))
      .catch((e) => console.log("CANT DELETE:", ctx.message, e));
  }

  // test link spam
  if (isMe(ctx) || isAllowList(ctx)) return;

  if (spamChecks.some((check) => check(ctx))) {
    console.log(`DELETING: ${ctx.message.message_id} ${ctx.message.text}`);

    ctx
      .deleteMessage(ctx.message.message_id)
      .then(() => deletedMessages.push(ctx.message.message_id))
      .catch((e) => console.log("CANT DELETE:", ctx.message, e));
  }
});

// TODO: replace name handle with chat id
// setInterval(() => {
//  bot.telegram.sendMessage("@soexpired", `${deletedMessages.splice(0).length} messages deleted`)
//    .catch((e) => console.log("CANT SEND MESSAGE:", e));
// }, 1000 * 60 * 60 * 24);

const botOptions = isProduction
  ? {
      webhook: {
        domain: WEBHOOK_URL,
        port: parseInt(PORT, 10),
      },
    }
  : {
      polling: { timeout: 30, limit: 10 },
    };

bot.launch(botOptions);

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
