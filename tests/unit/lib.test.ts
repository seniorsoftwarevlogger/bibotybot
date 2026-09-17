import { describe, it, expect, vi } from "vitest";
import { sendEphemeralMessage } from "../../src/lib.ts";

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
