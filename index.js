const { Telegraf } = require("telegraf");
const i18n = require("i18n");
const Sentry = require("@sentry/node");

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

const missingEnv = ["PORT", "BOT_TOKEN", "WEBHOOK_URL"].filter(
  (e) => !process.env[e]
);

const { PORT, BOT_TOKEN, NODE_ENV, WEBHOOK_URL } = process.env;

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

bot.hears(/t\.me\//, (ctx) => {
  console.log(`DELETING: ${ctx.message.message_id} ${ctx.message.text}`);
  ctx.deleteMessage(ctx.message.message_id).catch((e) => console.log("CANT DELETE:", ctx.message, e));
});

bot.on("message", (ctx, _post) => {
  console.log(`${ctx.message}`);
});

const botOptions =
  isProduction
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
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))