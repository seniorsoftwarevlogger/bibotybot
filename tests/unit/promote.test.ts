import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Collection, Db } from "mongodb";
import {
  isAdmin,
  parsePromoteCallback,
  parseUserTarget,
  promoteKeyboard,
} from "../../src/promote.ts";
import { getLevel, initPermissions, setOverride } from "../../src/permissions.ts";

describe("parseUserTarget", () => {
  it("takes the author of the replied-to message", () => {
    const from = { id: 42, first_name: "Alice" };
    expect(
      parseUserTarget({ text: "/promote", reply_to_message: { from } })
    ).toEqual({ kind: "user", user: from });
  });

  it("ignores replies to channel posts and the Telegram service user", () => {
    expect(
      parseUserTarget({
        text: "/promote",
        reply_to_message: { from: { id: 1, first_name: "Telegram" } },
      })
    ).toBeNull();
    expect(
      parseUserTarget({
        text: "/promote",
        reply_to_message: { from: { id: 1, first_name: "Channel" }, sender_chat: {} },
      })
    ).toBeNull();
  });

  it("reads @username from a mention", () => {
    const text = "/promote @Alice_Dev";
    expect(
      parseUserTarget({
        text,
        entities: [
          { type: "bot_command", offset: 0, length: 8 },
          { type: "mention", offset: 9, length: 10 },
        ],
      })
    ).toEqual({ kind: "username", username: "alice_dev" });
  });

  it("skips a mention of the bot itself", () => {
    const text = "/promote @bibotybot @bob";
    expect(
      parseUserTarget(
        {
          text,
          entities: [
            { type: "mention", offset: 9, length: 10 },
            { type: "mention", offset: 20, length: 4 },
          ],
        },
        "bibotybot"
      )
    ).toEqual({ kind: "username", username: "bob" });
  });

  it("takes the user from a text_mention", () => {
    const user = { id: 7, first_name: "NoUsername" };
    expect(
      parseUserTarget({
        text: "/promote NoUsername",
        entities: [{ type: "text_mention", offset: 9, length: 10, user }],
      })
    ).toEqual({ kind: "user", user });
  });

  it("returns null without a target", () => {
    expect(parseUserTarget({ text: "/promote" })).toBeNull();
  });
});

describe("promote callbacks", () => {
  it("round-trips every keyboard button", () => {
    const buttons = promoteKeyboard(123).inline_keyboard.flat();
    const parsed = buttons.map((b) => parsePromoteCallback(b.callback_data));
    expect(parsed.every((p) => p?.userId === 123)).toBe(true);
    expect(parsed.map((p) => (p?.action === "set" ? p.rank.tag : p?.action))).toEqual([
      "kB",
      "MB",
      "GB",
      "TB",
      "reset",
      "cancel",
    ]);
  });

  it("rejects unknown data", () => {
    expect(parsePromoteCallback("promote:123:PB")).toBeNull();
    expect(parsePromoteCallback("del:1:2:3:")).toBeNull();
  });
});

describe("isAdmin", () => {
  const CHAT = -100;
  const telegram = (statuses: Record<string, string>) =>
    ({
      getChatMember: vi.fn(async (chat: number | string) => ({
        status: statuses[String(chat)] ?? "member",
      })),
    }) as any;

  it("accepts an anonymous admin of the chat", async () => {
    expect(await isAdmin(telegram({}), CHAT, undefined, { id: CHAT }, [])).toBe(true);
  });

  it("accepts a post from our channel", async () => {
    expect(
      await isAdmin(telegram({}), CHAT, undefined, { id: 5, username: "ssv" }, ["ssv"])
    ).toBe(true);
  });

  it("rejects a post from a foreign channel", async () => {
    expect(
      await isAdmin(telegram({}), CHAT, undefined, { id: 5, username: "spam" }, ["ssv"])
    ).toBe(false);
  });

  it("accepts a chat admin and a channel admin, rejects a member", async () => {
    const user = { id: 1, first_name: "A" };
    expect(await isAdmin(telegram({ [CHAT]: "administrator" }), CHAT, user, undefined, [])).toBe(true);
    expect(await isAdmin(telegram({ "@ssv": "creator" }), CHAT, user, undefined, ["ssv"])).toBe(true);
    expect(await isAdmin(telegram({}), CHAT, user, undefined, ["ssv"])).toBe(false);
  });
});

describe("level overrides", () => {
  const CHAT = 2002;
  let overrideDoc: { messages: number } | null;
  const overrides = {
    findOne: vi.fn(async () => overrideDoc),
    updateOne: vi.fn(async (_q, update) => {
      overrideDoc = { messages: update.$set.messages };
    }),
    deleteOne: vi.fn(async () => {
      overrideDoc = null;
    }),
  } as unknown as Collection<any>;
  const stats = { findOne: vi.fn(async () => ({ messages: 3 })) } as unknown as Collection<any>;

  beforeEach(() => {
    overrideDoc = null;
    initPermissions(
      { collection: () => stats } as unknown as Db,
      { collection: () => overrides } as unknown as Db
    );
  });

  it("raises the effective count to the override and back on reset", async () => {
    await setOverride(CHAT, 1, 50, 99);
    const promoted = await getLevel(CHAT, 1);
    expect(promoted.messageCount).toBe(50);
    expect(promoted.realMessageCount).toBe(3);
    expect(promoted.override).toBe(50);
    expect(promoted.canMedia).toBe(true);

    await setOverride(CHAT, 1, null, 99);
    const reset = await getLevel(CHAT, 1);
    expect(reset.messageCount).toBe(3);
    expect(reset.override).toBeNull();
    expect(reset.canLink).toBe(false);
  });

  it("never lowers the real count", async () => {
    stats.findOne = vi.fn(async () => ({ messages: 200 })) as any;
    await setOverride(CHAT, 2, 10, 99);
    expect((await getLevel(CHAT, 2)).messageCount).toBe(200);
  });
});
