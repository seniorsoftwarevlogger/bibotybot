import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getRank,
  getLevel,
  initPermissions,
  invalidate,
  THRESHOLDS,
} from "../../src/permissions.ts";
import type { Collection, Db } from "mongodb";

function makeCollection(doc: { messages?: number } | null) {
  return {
    findOne: vi.fn().mockResolvedValue(doc),
  } as unknown as Collection<any>;
}

function makeDb(doc: { messages?: number } | null): Db {
  const col = makeCollection(doc);
  return { collection: () => col } as unknown as Db;
}

describe("getRank", () => {
  it("returns null below kB threshold", () => {
    expect(getRank(0)).toBeNull();
    expect(getRank(9)).toBeNull();
  });
  it("returns kB at 10", () => expect(getRank(10)).toBe("kB"));
  it("returns MB at 50", () => expect(getRank(50)).toBe("MB"));
  it("returns GB at 100", () => expect(getRank(100)).toBe("GB"));
  it("returns TB at 500", () => expect(getRank(500)).toBe("TB"));
  it("returns the highest tier for large counts", () => {
    expect(getRank(1000)).toBe("TB");
  });
});

describe("THRESHOLDS", () => {
  it("react < link < media", () => {
    expect(THRESHOLDS.react).toBeLessThan(THRESHOLDS.link);
    expect(THRESHOLDS.link).toBeLessThan(THRESHOLDS.media);
  });
});

describe("getLevel", () => {
  const CHAT = 1001;
  let uid = 0;
  const nextUid = () => ++uid * 10000; // unique IDs prevent cache collisions

  beforeEach(() => {
    // Always reset to a fresh db so the statistics reference is renewed.
    // Use unique user IDs per test to avoid TTL-cached hits from prior tests.
    initPermissions(makeDb(null));
  });

  it("returns zero counts for a new user (no DB doc)", async () => {
    const level = await getLevel(CHAT, nextUid());
    expect(level.messageCount).toBe(0);
    expect(level.canReact).toBe(false);
    expect(level.canLink).toBe(false);
    expect(level.canMedia).toBe(false);
  });

  it("sets canReact when messages >= react threshold", async () => {
    const uid = nextUid();
    initPermissions(makeDb({ messages: THRESHOLDS.react }));
    const level = await getLevel(CHAT, uid);
    expect(level.canReact).toBe(true);
    expect(level.canLink).toBe(false);
    expect(level.canMedia).toBe(false);
  });

  it("sets canLink when messages >= link threshold", async () => {
    const uid = nextUid();
    initPermissions(makeDb({ messages: THRESHOLDS.link }));
    const level = await getLevel(CHAT, uid);
    expect(level.canReact).toBe(true);
    expect(level.canLink).toBe(true);
    expect(level.canMedia).toBe(false);
  });

  it("sets all permissions when messages >= media threshold", async () => {
    const uid = nextUid();
    initPermissions(makeDb({ messages: THRESHOLDS.media }));
    const level = await getLevel(CHAT, uid);
    expect(level.canReact).toBe(true);
    expect(level.canLink).toBe(true);
    expect(level.canMedia).toBe(true);
  });

  it("caches the result and does not call DB a second time", async () => {
    const uid = nextUid();
    const col = makeCollection({ messages: 7 });
    const db = { collection: () => col } as unknown as Db;
    initPermissions(db);

    await getLevel(CHAT, uid);
    await getLevel(CHAT, uid);

    expect(col.findOne).toHaveBeenCalledTimes(1);
  });

  it("re-queries DB after cache is invalidated", async () => {
    const uid = nextUid();
    const col = makeCollection({ messages: 3 });
    const db = { collection: () => col } as unknown as Db;
    initPermissions(db);

    await getLevel(CHAT, uid);
    invalidate(CHAT, uid);
    await getLevel(CHAT, uid);

    expect(col.findOne).toHaveBeenCalledTimes(2);
  });
});
