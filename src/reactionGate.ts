import type { Telegraf } from "telegraf";
import { deleteUserReaction, muteFor24h, sendEphemeralMessage } from "./lib.ts";
import { notifyModAction } from "./modLog.ts";
import { getLevel, THRESHOLDS, type Level } from "./permissions.ts";

// Reactions are gated behind a small message threshold to keep reaction farms
// out. An early tap is a mistake rather than an attack, so the gate removes the
// reaction and privately tells the member which rule they hit — it does not mute
// them. The notice is throttled per member, because tapping reactions on a dozen
// posts should not produce a dozen messages. The clown trap is separate and still
// mutes: it is bait, and taking it is not a mistake.

const CLOWN_REACTION = "🤡";
const NOTICE_COOLDOWN_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

type Reaction = { type: string; emoji?: string };

type ReactionUpdate = {
  chat: { id: number };
  message_id: number;
  user?: { id: number; first_name?: string; username?: string };
  old_reaction?: Reaction[];
  new_reaction?: Reaction[];
};

const notices = new Map<string, number>();

function isClownReaction(reaction: Reaction) {
  return reaction.type === "emoji" && reaction.emoji === CLOWN_REACTION;
}

export function earlyReactionNotice(level: Level): string {
  return [
    `Правила чата: реакции доступны после ${THRESHOLDS.react} сообщений — у вас ${level.messageCount}.`,
    "Ваша реакция удалена.",
    "",
    "Полный список правил: /rules. Ваш прогресс: /stat.",
  ].join("\n");
}

export function setupReactionGate(
  bot: Telegraf,
  { family }: { family: () => string[] }
) {
  bot.on("message_reaction", async (ctx) => {
    const upd = ctx.update.message_reaction as ReactionUpdate | undefined;
    const userId = upd?.user?.id;
    if (!upd || !userId) return; // anonymous channel reactions are not attributed to a user

    if (upd.user?.username && family().includes(upd.user.username)) return;

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
      notifyModAction(ctx.telegram, {
        action: "mute24h",
        target: {
          kind: "user",
          id: userId,
          first_name: upd.user?.first_name,
          username: upd.user?.username,
        },
        chatId,
        chatTitle: ctx.chat?.title,
        reason: "🤡-реакция (клоунская ловушка)",
      });
      return;
    }

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

    const key = `${chatId}:${userId}`;
    const now = Date.now();
    if ((notices.get(key) ?? 0) > now) return;

    console.log(
      `reactionGate: removed early reaction by ${userId} in chat ${chatId} (${level.messageCount}/${THRESHOLDS.react} messages)`
    );
    try {
      await sendEphemeralMessage(
        ctx.telegram,
        chatId,
        userId,
        earlyReactionNotice(level)
      );
    } catch (error) {
      // Nothing reached the member, so don't start the cooldown — the next
      // early reaction tries again.
      console.error(
        `reactionGate: failed to notify ${userId} in ${chatId}:`,
        error
      );
      return;
    }
    notices.set(key, now + NOTICE_COOLDOWN_MS);
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, expiresAt] of notices) {
      if (expiresAt <= now) notices.delete(key);
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref();
}
