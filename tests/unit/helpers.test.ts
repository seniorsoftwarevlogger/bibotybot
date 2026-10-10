import { describe, it, expect } from "vitest";
import {
  boostCacheKey,
  hasLinks,
  isChannelBot,
  isMe,
  isOwnChannelExternalReply,
  isStatCommand,
  isTelegramServiceUser,
  isThreadRuleCommand,
  normalizeEditedMessage,
} from "../../src/helpers.ts";

describe("boostCacheKey", () => {
  it("formats channelId:userId", () => {
    expect(boostCacheKey(123, 456)).toBe("123:456");
    expect(boostCacheKey("@channel", 789)).toBe("@channel:789");
  });
});

describe("isTelegramServiceUser", () => {
  it("matches Telegram service user", () => {
    expect(isTelegramServiceUser({ first_name: "Telegram" })).toBe(true);
  });
  it("does not match regular users", () => {
    expect(isTelegramServiceUser({ first_name: "Alice" })).toBe(false);
    expect(isTelegramServiceUser({})).toBe(false);
  });
});

describe("isStatCommand", () => {
  it("matches /stat", () => {
    expect(isStatCommand({ message: { text: "/stat" } })).toBe(true);
    expect(isStatCommand({ message: { text: "/stat@bibotybot" } })).toBe(true);
    expect(isStatCommand({ message: { text: "/stat some arg" } })).toBe(true);
    expect(isStatCommand({ message: { text: "@bibotybot/stat" } })).toBe(true);
  });
  it("does not match non-stat text", () => {
    expect(isStatCommand({ message: { text: "hello" } })).toBe(false);
    expect(isStatCommand({ message: { text: "/ban" } })).toBe(false);
    expect(isStatCommand({ message: {} })).toBe(false);
  });
});

describe("isThreadRuleCommand", () => {
  it("matches the thread allow/disallow commands", () => {
    for (const command of [
      "/allow_links",
      "/allow_media",
      "/disallow_links",
      "/disallow_media",
    ]) {
      expect(isThreadRuleCommand({ message: { text: command } })).toBe(true);
      expect(
        isThreadRuleCommand({ message: { text: `${command}@bibotybot` } })
      ).toBe(true);
    }
  });

  it("does not match other commands or text", () => {
    expect(isThreadRuleCommand({ message: { text: "/allow" } })).toBe(false);
    expect(isThreadRuleCommand({ message: { text: "/allow_links_now" } })).toBe(false);
    expect(isThreadRuleCommand({ message: { text: "/unban" } })).toBe(false);
    expect(isThreadRuleCommand({ message: { text: "allow links" } })).toBe(false);
    expect(isThreadRuleCommand({ message: {} })).toBe(false);
  });
});

describe("normalizeEditedMessage", () => {
  it("aliases an edited message into update.message", () => {
    const ctx = {
      update: {
        edited_message: { message_id: 1, text: "edited", chat: { id: -100 } },
      },
    };
    normalizeEditedMessage(ctx);
    expect(ctx.update.message).toBe(ctx.update.edited_message);
  });

  it("does not touch new-message updates", () => {
    const ctx = {
      update: { message: { message_id: 1, text: "new", chat: { id: -100 } } },
    };
    normalizeEditedMessage(ctx);
    expect(ctx.update.message).toEqual({ message_id: 1, text: "new", chat: { id: -100 } });
    expect("edited_message" in ctx.update).toBe(false);
  });

  it("does not overwrite message when both are present", () => {
    const ctx = {
      update: {
        message: { message_id: 1, text: "original" },
        edited_message: { message_id: 1, text: "edited" },
      },
    };
    normalizeEditedMessage(ctx);
    expect((ctx.update.message as { text: string }).text).toBe("original");
  });

  it("ignores updates without messages", () => {
    const ctx = { update: { chat_member: { chat: { id: -100 } } } };
    normalizeEditedMessage(ctx);
    expect("message" in ctx.update).toBe(false);
  });
});

describe("isChannelBot", () => {
  it("returns true when sender first_name is Channel", () => {
    expect(isChannelBot({ message: { from: { first_name: "Channel" } } })).toBe(true);
  });
  it("returns false for regular users", () => {
    expect(isChannelBot({ message: { from: { first_name: "Alice" } } })).toBe(false);
    expect(isChannelBot({ message: {} })).toBe(false);
    expect(isChannelBot({})).toBe(false);
  });
});

describe("isMe", () => {
  const myChannels = ["seniorsoftwarevlogger", "teamleadtalks"];

  it("returns true for Telegram service user", () => {
    expect(
      isMe({ message: { from: { first_name: "Telegram" } } }, myChannels)
    ).toBe(true);
  });

  it("returns true for own channel bot", () => {
    expect(
      isMe(
        {
          message: {
            from: { first_name: "Channel" },
            sender_chat: { username: "seniorsoftwarevlogger" },
          },
        },
        myChannels
      )
    ).toBe(true);
  });

  it("returns false for foreign channel bot", () => {
    expect(
      isMe(
        {
          message: {
            from: { first_name: "Channel" },
            sender_chat: { username: "foreignchannel" },
          },
        },
        myChannels
      )
    ).toBe(false);
  });

  it("returns false for regular user", () => {
    expect(
      isMe({ message: { from: { first_name: "Alice", id: 1 } } }, myChannels)
    ).toBe(false);
  });

  it("returns false when message is absent", () => {
    expect(isMe({}, myChannels)).toBe(false);
  });
});

describe("hasLinks", () => {
  it("returns true for url entity", () => {
    expect(
      hasLinks({ message: { entities: [{ type: "url" }] } })
    ).toBe(true);
  });
  it("returns true for text_link entity", () => {
    expect(
      hasLinks({ message: { entities: [{ type: "text_link" }] } })
    ).toBe(true);
  });
  it("returns false for unrelated entity types", () => {
    expect(
      hasLinks({ message: { entities: [{ type: "bold" }, { type: "mention" }] } })
    ).toBe(false);
  });
  it("returns false when entities are absent", () => {
    expect(hasLinks({ message: {} })).toBe(false);
    expect(hasLinks({})).toBe(false);
  });
});

describe("isOwnChannelExternalReply", () => {
  const myChannels = ["seniorsoftwarevlogger"];
  const CHAT_ID = 1001;
  const CHANNEL_ID = 2001;

  function makeCtx(overrides: Record<string, unknown> = {}) {
    return {
      message: {
        chat: { id: CHAT_ID },
        external_reply: {
          origin: { chat: { id: CHANNEL_ID, username: "seniorsoftwarevlogger" } },
          chat: { id: CHANNEL_ID, username: "seniorsoftwarevlogger" },
        },
        reply_to_message: {
          chat: { id: CHAT_ID },
          sender_chat: { id: CHANNEL_ID },
        },
        ...overrides,
      },
    };
  }

  it("returns true for own-channel cross-post reply", () => {
    expect(isOwnChannelExternalReply(makeCtx(), myChannels)).toBe(true);
  });

  it("returns false when external channel is not own channel", () => {
    const ctx = makeCtx();
    ctx.message.external_reply.origin.chat.username = "foreignchannel";
    ctx.message.external_reply.chat.username = "foreignchannel";
    expect(isOwnChannelExternalReply(ctx, myChannels)).toBe(false);
  });

  it("returns false when origin and reply chat ids differ", () => {
    const ctx = makeCtx();
    ctx.message.external_reply.origin.chat.id = 9999;
    expect(isOwnChannelExternalReply(ctx, myChannels)).toBe(false);
  });
});
