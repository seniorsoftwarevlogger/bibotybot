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

const { ME, PORT, BOT_TOKEN, NODE_ENV, WEBHOOK_URL, ALLOW, FAMILY } =
  process.env;

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
  return message.from?.username && allowList.includes(message.from?.username);
}
function isChannelBot({ message }) {
  return message.from.first_name === "Channel";
}
function hasLink(ctx) {
  return ctx.message.entities?.some((entity) => entity.type === "url");
  // return ctx.message.text?.includes("t.me");
}

const spamChecks = [isChannelBot, hasLink];

bot.on("message", (ctx) => {
  if (isMe(ctx) || family.includes(ctx.message.from.username)) return;

  // Delete media messages
  if (!ctx.message.text) {
    // block user from sending media
    return ctx
      .deleteMessage(ctx.message.message_id)
      .then(() =>
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
        })
      )
      .catch((e) => console.log("CANT DELETE:", ctx.message, e));
  }

  // Delete links
  if (!isAllowList(ctx) && spamChecks.some((check) => check(ctx))) {
    return ctx
      .deleteMessage(ctx.message.message_id)
      .catch((e) => console.log("CANT DELETE:", ctx.message, e));
  }
});

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
