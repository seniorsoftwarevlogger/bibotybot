import { describe, it, expect, vi } from "vitest";
import type { Collection, Db } from "mongodb";
import {
  initThreadRules,
  NO_THREAD_HINT,
  ruleText,
  setThreadRule,
  threadAllows,
  THREAD_RULE_COMMANDS,
} from "../../src/threadRules.ts";

const CHAT = -1001234567890;

type Doc = {
  chat_id: number;
  thread_id: number;
  allow_links?: boolean;
  allow_media?: boolean;
};

// The rules map is module state, so every test works on its own thread id.
function makeDb(initial: Doc[] = []) {
  const docs = new Map(initial.map((doc) => [`${doc.chat_id}:${doc.thread_id}`, doc]));
  const collection = {
    find: vi.fn(() => ({ toArray: async () => [...docs.values()] })),
    updateOne: vi.fn(async (query: Doc, update: { $set: Record<string, unknown> }) => {
      docs.set(`${query.chat_id}:${query.thread_id}`, { ...query, ...update.$set });
    }),
    deleteOne: vi.fn(async (query: Doc) => {
      docs.delete(`${query.chat_id}:${query.thread_id}`);
    }),
  } as unknown as Collection<Doc>;

  return {
    db: { collection: () => collection } as unknown as Db,
    docs,
    collection,
  };
}

describe("thread rules", () => {
  it("loads the stored rules at startup", async () => {
    const { db } = makeDb([
      { chat_id: CHAT, thread_id: 101, allow_links: true },
      { chat_id: CHAT, thread_id: 102, allow_media: true },
    ]);
    await initThreadRules(db);

    expect(threadAllows(CHAT, 101, "links")).toBe(true);
    expect(threadAllows(CHAT, 101, "media")).toBe(false);
    expect(threadAllows(CHAT, 102, "media")).toBe(true);
    expect(threadAllows(CHAT, 102, "links")).toBe(false);
  });

  it("allows nothing for an unmarked thread, another chat, or no thread at all", async () => {
    const { db } = makeDb([{ chat_id: CHAT, thread_id: 103, allow_links: true }]);
    await initThreadRules(db);

    expect(threadAllows(CHAT, 999, "links")).toBe(false);
    expect(threadAllows(CHAT + 1, 103, "links")).toBe(false);
    expect(threadAllows(CHAT, undefined, "links")).toBe(false);
    expect(threadAllows(CHAT, 0, "media")).toBe(false);
  });

  it("keeps the other permission when one is changed", async () => {
    const { db, docs } = makeDb();
    await initThreadRules(db);

    await setThreadRule(CHAT, 104, "links", true, 777);
    const rule = await setThreadRule(CHAT, 104, "media", true, 777);

    expect(rule).toEqual({ links: true, media: true });
    expect(docs.get(`${CHAT}:104`)).toMatchObject({
      allow_links: true,
      allow_media: true,
      set_by: 777,
    });
  });

  it("drops the stored rule once both permissions are back to the defaults", async () => {
    const { db, docs, collection } = makeDb([
      { chat_id: CHAT, thread_id: 105, allow_links: true },
    ]);
    await initThreadRules(db);

    await setThreadRule(CHAT, 105, "links", false, 777);

    expect(threadAllows(CHAT, 105, "links")).toBe(false);
    expect(docs.has(`${CHAT}:105`)).toBe(false);
    expect(collection.deleteOne).toHaveBeenCalled();
  });

  it("keeps the rule in memory when the database write fails", async () => {
    const { db } = makeDb();
    (db.collection("thread_rules") as unknown as { updateOne: unknown }).updateOne =
      vi.fn(async () => {
        throw new Error("no write access");
      });
    await initThreadRules(db);

    const rule = await setThreadRule(CHAT, 106, "links", true, 777);

    expect(rule.links).toBe(true);
    expect(threadAllows(CHAT, 106, "links")).toBe(true);
  });
});

describe("thread rule commands", () => {
  it("maps every command to a permission and a verdict", () => {
    expect(THREAD_RULE_COMMANDS).toEqual({
      allow_links: { permission: "links", allow: true },
      allow_media: { permission: "media", allow: true },
      disallow_links: { permission: "links", allow: false },
      disallow_media: { permission: "media", allow: false },
    });
  });

  it("reports the resulting state of the thread", () => {
    expect(ruleText({ links: true, media: false }, "links", true)).toContain(
      "можно постить ссылки"
    );
    expect(ruleText({ links: false, media: false }, "media", false)).toContain(
      "снова по общим правилам"
    );
    expect(NO_THREAD_HINT).toContain("в комментариях к посту");
  });
});
