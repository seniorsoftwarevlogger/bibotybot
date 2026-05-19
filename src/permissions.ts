import type { Collection, Db } from "mongodb";

export const THRESHOLDS = {
  react: 5,
  link: 20,
  media: 50,
} as const;

const CACHE_TTL_MS = 60_000;

export type Level = {
  messageCount: number;
  canReact: boolean;
  canLink: boolean;
  canMedia: boolean;
};

type StatsDoc = { chat_id: number; user_id: number; messages?: number };

let statistics: Collection<StatsDoc> | null = null;

const cache = new Map<string, { level: Level; expiresAt: number }>();

export function initPermissions(db: Db) {
  statistics = db.collection<StatsDoc>("statistics");
}

export async function getLevel(chatId: number, userId: number): Promise<Level> {
  if (!statistics) {
    throw new Error("permissions: initPermissions(db) was not called");
  }

  const key = `${chatId}:${userId}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.level;

  const doc = await statistics
    .findOne({ chat_id: chatId, user_id: userId })
    .catch((e) => {
      console.error("permissions: findOne failed", e);
      return null;
    });

  const count = doc?.messages ?? 0;
  const level: Level = {
    messageCount: count,
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
