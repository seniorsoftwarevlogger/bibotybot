import type { Collection, Db } from "mongodb";
import type { Telegraf } from "telegraf";
import { sendEphemeralMessage } from "./lib.ts";
import type { Level } from "./permissions.ts";

// Capabilities unlock as the message count grows, but nothing ever told the
// member: rank tags are applied silently and /stat was the only way to find
// out the level system exists. Each unlock is announced once, as an ephemeral
// message only that member sees, and recorded in the database — without the
// record every restart would greet the whole chat with "you unlocked links".

export type Capability = "react" | "link" | "media";

const CAPABILITIES: {
  key: Capability;
  unlocked: (level: Level) => boolean;
  what: string;
}[] = [
  { key: "react", unlocked: (level) => level.canReact, what: "реакции на сообщения" },
  { key: "link", unlocked: (level) => level.canLink, what: "ссылки" },
  { key: "media", unlocked: (level) => level.canMedia, what: "фото и видео" },
];

type UnlockDoc = {
  chat_id: number;
  user_id: number;
  unlocked: Capability[];
  updated_at: Date;
};

let unlockDocs: Collection<UnlockDoc> | null = null;

// Memory first, database second: one read per member per process, and a failed
// write must not make the next message announce the same unlock again.
const announced = new Map<string, Set<Capability>>();

export function initUnlocks(db: Db) {
  unlockDocs = db.collection<UnlockDoc>("level_unlocks");
}

export function unlockText(caps: Capability[], messageCount: number): string {
  const names = CAPABILITIES.filter((capability) =>
    caps.includes(capability.key)
  ).map((capability) => `• ${capability.what}`);

  return [
    `🔓 Набрано ${messageCount} сообщений — теперь доступно:`,
    ...names,
    "",
    "Правила чата: /rules. Ваша статистика: /stat.",
  ].join("\n");
}

async function loadAnnounced(
  chatId: number,
  userId: number
): Promise<Capability[]> {
  if (!unlockDocs) return [];
  try {
    const doc = await unlockDocs.findOne({ chat_id: chatId, user_id: userId });
    return doc?.unlocked ?? [];
  } catch (error) {
    console.error(`unlocks: failed to read record for ${userId} in ${chatId}`, error);
    return [];
  }
}

async function recordAnnounced(
  chatId: number,
  userId: number,
  caps: Capability[]
): Promise<void> {
  if (!unlockDocs) return;
  try {
    await unlockDocs.updateOne(
      { chat_id: chatId, user_id: userId },
      {
        $addToSet: { unlocked: { $each: caps } },
        $set: { updated_at: new Date() },
      },
      { upsert: true }
    );
  } catch (error) {
    console.error(`unlocks: failed to record ${caps} for ${userId} in ${chatId}`, error);
  }
}

// Returns the capabilities announced by this call, so tests can assert on it.
export async function announceUnlocks(
  telegram: Telegraf["telegram"],
  chatId: number,
  userId: number,
  level: Level
): Promise<Capability[]> {
  const unlocked = CAPABILITIES.filter((capability) => capability.unlocked(level)).map(
    (capability) => capability.key
  );
  if (unlocked.length === 0) return [];

  const key = `${chatId}:${userId}`;
  let seen = announced.get(key);
  if (!seen) {
    seen = new Set(await loadAnnounced(chatId, userId));
    announced.set(key, seen);
  }
  const alreadyAnnounced = seen;

  const fresh = unlocked.filter((capability) => !alreadyAnnounced.has(capability));
  if (fresh.length === 0) return [];

  try {
    await sendEphemeralMessage(
      telegram,
      chatId,
      userId,
      unlockText(fresh, level.messageCount)
    );
  } catch (error) {
    // Nothing reached the member, so don't record it — a later message retries.
    console.error(`unlocks: failed to notify ${userId} in ${chatId}:`, error);
    return [];
  }

  for (const capability of fresh) alreadyAnnounced.add(capability);
  console.log(`unlocks: ${userId} in ${chatId} unlocked ${fresh.join(", ")}`);
  await recordAnnounced(chatId, userId, fresh);
  return fresh;
}

export function setupUnlocks(bot: Telegraf) {
  // Registered after the level middleware, which is what fills ctx.state.level
  // and also stops the chain for the bot's own channels and the family.
  bot.use(async (ctx, next) => {
    const level = ctx.state?.level;
    const userId = ctx.message?.from?.id;
    if (level && userId && ctx.chat && !ctx.message?.from?.is_bot) {
      await announceUnlocks(ctx.telegram, ctx.chat.id, userId, level);
    }
    return next();
  });
}
