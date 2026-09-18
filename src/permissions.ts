import type { Collection, Db } from "mongodb";

export const THRESHOLDS = {
  react: 5,
  link: 20,
  media: 50,
} as const;

export const RANKS = [
  { count: 500, tag: "TB" },
  { count: 100, tag: "GB" },
  { count: 50, tag: "MB" },
  { count: 10, tag: "kB" },
] as const;

export type Rank = (typeof RANKS)[number]["tag"] | null;

export function getRank(messageCount: number): Rank {
  for (const rank of RANKS) {
    if (messageCount >= rank.count) return rank.tag;
  }
  return null;
}

const CACHE_TTL_MS = 60_000;

export type Level = {
  // Effective count: the real one, raised to the manual override if an admin set one.
  messageCount: number;
  realMessageCount: number;
  override: number | null;
  canReact: boolean;
  canLink: boolean;
  canMedia: boolean;
};

type StatsDoc = { chat_id: number; user_id: number; messages?: number };
type OverrideDoc = {
  chat_id: number;
  user_id: number;
  messages: number;
  set_by: number;
  updated_at: Date;
};

let statistics: Collection<StatsDoc> | null = null;
let overrides: Collection<OverrideDoc> | null = null;

const cache = new Map<string, { level: Level; expiresAt: number }>();

// `statsDb` is achivator bot's database (read only). `overridesDb` is ours and
// keeps levels that admins granted out of turn via /promote.
export function initPermissions(statsDb: Db, overridesDb?: Db) {
  statistics = statsDb.collection<StatsDoc>("statistics");
  overrides = overridesDb?.collection<OverrideDoc>("level_overrides") ?? null;
}

export async function getLevel(chatId: number, userId: number): Promise<Level> {
  if (!statistics) {
    throw new Error("permissions: initPermissions(db) was not called");
  }

  const key = `${chatId}:${userId}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.level;

  const [doc, overrideDoc] = await Promise.all([
    statistics.findOne({ chat_id: chatId, user_id: userId }).catch((e) => {
      console.error("permissions: findOne failed", e);
      return null;
    }),
    overrides?.findOne({ chat_id: chatId, user_id: userId }).catch((e) => {
      console.error("permissions: override findOne failed", e);
      return null;
    }) ?? null,
  ]);

  const realCount = doc?.messages ?? 0;
  const override = overrideDoc?.messages ?? null;
  const count = Math.max(realCount, override ?? 0);
  const level: Level = {
    messageCount: count,
    realMessageCount: realCount,
    override,
    canReact: count >= THRESHOLDS.react,
    canLink: count >= THRESHOLDS.link,
    canMedia: count >= THRESHOLDS.media,
  };

  cache.set(key, { level, expiresAt: now + CACHE_TTL_MS });
  return level;
}

export function invalidate(chatId: number, userId: number) {
  cache.delete(`${chatId}:${userId}`);
}

// Sets the minimum message count the user is treated as having, or removes it
// when `messages` is null.
export async function setOverride(
  chatId: number,
  userId: number,
  messages: number | null,
  setBy: number
) {
  if (!overrides) {
    throw new Error("permissions: overrides database is not configured");
  }

  if (messages === null) {
    await overrides.deleteOne({ chat_id: chatId, user_id: userId });
  } else {
    await overrides.updateOne(
      { chat_id: chatId, user_id: userId },
      { $set: { messages, set_by: setBy, updated_at: new Date() } },
      { upsert: true }
    );
  }
  invalidate(chatId, userId);
}
