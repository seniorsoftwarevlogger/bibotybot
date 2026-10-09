import { describe, it, expect, afterEach } from "vitest";
import {
  formatModAction,
  modLogChat,
  modTargetFromMessage,
  parseModUnbanCallback,
} from "../../src/modLog.ts";

describe("modLogChat", () => {
  afterEach(() => {
    delete process.env.MOD_CHAT_ID;
  });

  it("defaults to the quarantine channel", () => {
    expect(modLogChat()).toBe("@ssv_purge");
  });

  it("can be overridden via MOD_CHAT_ID", () => {
    process.env.MOD_CHAT_ID = "@mod_chat";
    expect(modLogChat()).toBe("@mod_chat");
  });
});

describe("modTargetFromMessage", () => {
  it("takes the user for regular messages", () => {
    expect(
      modTargetFromMessage({
        from: { id: 42, first_name: "Alice", username: "alice" },
      })
    ).toEqual({ kind: "user", id: 42, first_name: "Alice", username: "alice" });
  });

  it("takes the channel for channel-bot posts", () => {
    expect(
      modTargetFromMessage({
        from: { id: 136817688, first_name: "Channel" },
        sender_chat: { id: -100123, username: "spamchannel" },
      })
    ).toEqual({ kind: "channel", id: -100123, username: "spamchannel" });
  });
});

describe("formatModAction", () => {
  const base = {
    chatId: -1001234567890,
    chatTitle: "Senior Software Vlogger",
  };

  it("describes a user block with quarantine link", () => {
    const text = formatModAction({
      ...base,
      action: "block",
      target: { kind: "user", id: 42, first_name: "Alice", username: "alice" },
      reason: "Ссылки за буст канала",
      quarantineMessageId: 999,
    });
    expect(text).toContain("Блокировка");
    expect(text).toContain("Alice @alice 42");
    expect(text).toContain("Senior Software Vlogger (-1001234567890)");
    expect(text).toContain("Причина: Ссылки за буст канала");
    expect(text).toContain("https://t.me/ssv_purge/999");
  });

  it("truncates long reasons", () => {
    const text = formatModAction({
      ...base,
      action: "mute24h",
      target: { kind: "user", id: 42 },
      reason: "x".repeat(300),
    });
    expect(text).toContain("Мут на 24 часа");
    expect(text).not.toContain("x".repeat(200));
    expect(text).toContain("…");
  });

  it("describes a channel without a user handle", () => {
    const text = formatModAction({
      ...base,
      action: "block",
      target: { kind: "channel", id: -100555, username: "spamchannel" },
      reason: "Под каналом писать нельзя",
    });
    expect(text).toContain("канал @spamchannel");
    expect(text).toContain("Причина: Под каналом писать нельзя");
  });
});

describe("parseModUnbanCallback", () => {
  it("parses a chat id and user id", () => {
    expect(parseModUnbanCallback("modunban:-1001234567890:42")).toEqual({
      chatId: -1001234567890,
      userId: 42,
    });
  });

  it("rejects other callback data", () => {
    expect(parseModUnbanCallback("modunban:42")).toBeNull();
    expect(parseModUnbanCallback("joingate:-100:42")).toBeNull();
    expect(parseModUnbanCallback("del:1:2:3:")).toBeNull();
    expect(parseModUnbanCallback("modunban:abc:42")).toBeNull();
  });
});
