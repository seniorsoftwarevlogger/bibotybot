import { describe, it, expect, vi } from "vitest";
import {
  restrictReactionsFor,
  sendEphemeralMessage,
} from "../../src/lib.ts";

describe("sendEphemeralMessage", () => {
  it("posts via sendMessage addressed to a single user with receiver_user_id", async () => {
    const telegram = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };

    await sendEphemeralMessage(telegram, -1001234567890, 42, "Сообщение удалено");

    expect(telegram.sendMessage).toHaveBeenCalledWith(
      -1001234567890,
      "Сообщение удалено",
      expect.objectContaining({ receiver_user_id: 42 })
    );
  });

  it("disables link previews and merges caller-supplied extra options", async () => {
    const telegram = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };

    await sendEphemeralMessage(telegram, -100, 7, "hi", { parse_mode: "HTML" });

    const [, , extra] = telegram.sendMessage.mock.calls[0];
    expect(extra.receiver_user_id).toBe(7);
    expect(extra.link_preview_options).toEqual({ is_disabled: true });
    expect(extra.parse_mode).toBe("HTML");
  });
});

describe("restrictReactionsFor", () => {
  it("takes away only reactions, for the requested duration", async () => {
    const telegram = { restrictChatMember: vi.fn().mockResolvedValue(true) };
    const before = Math.floor(Date.now() / 1000);

    await restrictReactionsFor(telegram, -1001234567890, 42, 60_000);

    const [chatId, userId, extra] = telegram.restrictChatMember.mock.calls[0];
    expect(chatId).toBe(-1001234567890);
    expect(userId).toBe(42);
    expect(extra.permissions.can_react_to_messages).toBe(false);
    // Everything else stays allowed — restrictChatMember replaces the whole set.
    expect(extra.permissions.can_send_messages).toBe(true);
    expect(extra.permissions.can_send_other_messages).toBe(true);
    expect(extra.until_date).toBeGreaterThanOrEqual(before + 60);
    expect(extra.until_date).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000) + 60
    );
  });
});
