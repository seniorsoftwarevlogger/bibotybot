import { describe, it, expect, vi } from "vitest";
import type { Db } from "mongodb";
import { announceUnlocks, initUnlocks, unlockText } from "../../src/unlocks.ts";
import { THRESHOLDS, type Level } from "../../src/permissions.ts";

const CHAT_ID = -1001234567890;

function level(messageCount: number): Level {
  return {
    messageCount,
    realMessageCount: messageCount,
    override: null,
    canReact: messageCount >= THRESHOLDS.react,
    canLink: messageCount >= THRESHOLDS.link,
    canMedia: messageCount >= THRESHOLDS.media,
  };
}

function makeTelegram() {
  return { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) } as any;
}

// The announced set is module state that outlives a test, so every test uses
// its own member id.
function makeDb(existing?: string[]) {
  const collection = {
    findOne: vi.fn().mockResolvedValue(existing ? { unlocked: existing } : null),
    updateOne: vi.fn().mockResolvedValue({}),
  };
  return {
    db: { collection: () => collection } as unknown as Db,
    collection,
  };
}

describe("unlockText", () => {
  it("says what opened and where to read more", () => {
    const text = unlockText(["link"], 20);
    expect(text).toContain("Набрано 20 сообщений");
    expect(text).toContain("ссылки");
    expect(text).toContain("/rules");
    expect(text).toContain("/stat");
  });

  it("lists several capabilities at once", () => {
    const text = unlockText(["react", "media"], 50);
    expect(text).toContain("реакции");
    expect(text).toContain("фото и видео");
    expect(text).not.toContain("ссылки");
  });
});

describe("announceUnlocks", () => {
  it("announces everything newly unlocked in one private message", async () => {
    const userId = 9101;
    const { db, collection } = makeDb();
    initUnlocks(db);
    const telegram = makeTelegram();

    const caps = await announceUnlocks(
      telegram,
      CHAT_ID,
      userId,
      level(THRESHOLDS.link)
    );

    expect(caps).toEqual(["react", "link"]);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, extra] = telegram.sendMessage.mock.calls[0];
    expect(chatId).toBe(CHAT_ID);
    expect(text).toContain("ссылки");
    expect(extra.receiver_user_id).toBe(userId);
    expect(collection.updateOne).toHaveBeenCalledWith(
      { chat_id: CHAT_ID, user_id: userId },
      expect.objectContaining({
        $addToSet: { unlocked: { $each: ["react", "link"] } },
      }),
      { upsert: true }
    );
  });

  it("stays quiet below every threshold and skips the database", async () => {
    const userId = 9102;
    const { db, collection } = makeDb();
    initUnlocks(db);
    const telegram = makeTelegram();

    expect(await announceUnlocks(telegram, CHAT_ID, userId, level(0))).toEqual([]);
    expect(collection.findOne).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("reads the record first, so a restart repeats nothing", async () => {
    const userId = 9103;
    const { db, collection } = makeDb(["react", "link"]);
    initUnlocks(db);
    const telegram = makeTelegram();

    expect(
      await announceUnlocks(telegram, CHAT_ID, userId, level(THRESHOLDS.link))
    ).toEqual([]);
    expect(collection.findOne).toHaveBeenCalledWith({
      chat_id: CHAT_ID,
      user_id: userId,
    });
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("announces the next threshold once, then never again", async () => {
    const userId = 9104;
    const { db } = makeDb(["react", "link"]);
    initUnlocks(db);
    const telegram = makeTelegram();

    expect(
      await announceUnlocks(telegram, CHAT_ID, userId, level(THRESHOLDS.media))
    ).toEqual(["media"]);
    expect(
      await announceUnlocks(telegram, CHAT_ID, userId, level(THRESHOLDS.media))
    ).toEqual([]);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("records nothing when delivery fails, so a later message retries", async () => {
    const userId = 9105;
    const { db, collection } = makeDb();
    initUnlocks(db);
    const broken = {
      sendMessage: vi.fn().mockRejectedValue(new Error("429")),
    } as any;

    expect(
      await announceUnlocks(broken, CHAT_ID, userId, level(THRESHOLDS.react))
    ).toEqual([]);
    expect(collection.updateOne).not.toHaveBeenCalled();

    const telegram = makeTelegram();
    expect(
      await announceUnlocks(telegram, CHAT_ID, userId, level(THRESHOLDS.react))
    ).toEqual(["react"]);
  });
});
