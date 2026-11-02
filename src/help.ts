import type { Telegraf } from "telegraf";
import { QUARANTINE_CHAT } from "./lib.ts";
import { EMOJI_LIMIT, RANKS, THRESHOLDS } from "./permissions.ts";

// The bot's front door. Members had no way to read the rules except by
// breaking one, and a private chat with the bot answered with a raw JSON dump
// of the update. /rules and /help give them the same text the gates enforce,
// built from the same constants, so it cannot drift out of sync.

const RESULT_TTL_MS = 60_000;

const rankLine = [...RANKS]
  .reverse()
  .map((rank) => `${rank.tag} — ${rank.count}`)
  .join(", ");

// The bullets quoted by both /rules and the join-gate captcha.
export function rulesList(): string[] {
  return [
    `• реакции — после ${THRESHOLDS.react} сообщений;`,
    `• ссылки — после ${THRESHOLDS.link} сообщений или за буст канала;`,
    `• медиа — после ${THRESHOLDS.media} сообщений;`,
    `• не больше ${EMOJI_LIMIT} кастомных эмодзи в одном сообщении;`,
    "• спам и реклама — автоматическая блокировка;",
    "• писать от имени канала и отвечать ссылками на чужие посты нельзя.",
  ];
}

export function rulesText(chatTitle?: string): string {
  return [
    chatTitle ? `Правила чата «${chatTitle}»:` : "Правила чата:",
    "",
    ...rulesList(),
    "",
    `Удалённые сообщения попадают в карантин ${QUARANTINE_CHAT}.`,
    "",
    `Ранги за сообщения: ${rankLine}.`,
    "Ваш прогресс: /stat",
  ].join("\n");
}

export function helpText(): string {
  return [
    "Я модератор и помощник чата.",
    "",
    "Что я делаю:",
    "• проверяю новичков: первое сообщение нужно подтвердить кнопкой «Я не бот»;",
    "• слежу за правилами чата — ссылки, медиа, спам, кастомные эмодзи;",
    "• начисляю ранги за сообщения и подсказываю, когда открылась новая возможность.",
    "",
    "Команды:",
    "/rules — правила чата;",
    "/stat — ваша статистика и уровень (можно ответить на сообщение участника);",
    "/help — это сообщение.",
  ].join("\n");
}

// Replies where the question was asked: ctx.reply only forwards the thread for
// forum topics (is_topic_message), never for a channel post's comment thread,
// so message_thread_id has to be passed explicitly or the answer lands in the
// group's main chat, invisible to the asker. The command and its answer are
// then removed — the chat shouldn't keep a pile of /rules transcripts.
async function answerInChat(ctx, text: string) {
  const commandId = ctx.message?.message_id;
  const threadId = ctx.message?.message_thread_id;

  const sent = await ctx.reply(
    text,
    threadId ? { message_thread_id: threadId } : undefined
  );

  if (!commandId) return;
  await ctx.deleteMessage(commandId).catch((error) => {
    console.log("CANT DELETE HELP COMMAND:", commandId, error);
  });
  setTimeout(() => {
    ctx.telegram.deleteMessage(ctx.chat.id, sent.message_id).catch((error) => {
      console.log("CANT DELETE HELP REPLY:", sent.message_id, error);
    });
  }, RESULT_TTL_MS);
}

export function setupHelp(bot: Telegraf) {
  const showRules = async (ctx) => {
    if (ctx.chat?.type === "private") {
      await ctx.reply(rulesText());
      return;
    }
    await answerInChat(ctx, rulesText(ctx.chat?.title));
  };

  const showHelp = async (ctx) => {
    if (ctx.chat?.type === "private") {
      await ctx.reply(helpText());
      return;
    }
    await answerInChat(ctx, helpText());
  };

  bot.command("rules", showRules);
  bot.command(["help", "start"], showHelp);

  // Anything else in a private chat: point at what the bot is for instead of
  // running moderation on a conversation nobody else can see. Fresh messages
  // only: an edit is aliased into update.message upstream, and a callback whose
  // message came from a private chat also has ctx.chat.
  bot.use(async (ctx, next) => {
    const { message, edited_message: editedMessage } = ctx.update;
    if (ctx.chat?.type !== "private" || !message || editedMessage) return next();
    await ctx.reply(helpText()).catch((error) => {
      console.error("help: failed to answer in private chat:", error);
    });
  });
}
