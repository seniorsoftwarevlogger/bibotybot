import { describe, it, expect, vi } from "vitest";
import { classifyMessageOpenAI } from "../../src/openaiClassifier.ts";
import type { OpenAI } from "openai";

function makeClient(answer: string | null): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: answer } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

describe("classifyMessageOpenAI", () => {
  it('returns true when OpenAI answers "да"', async () => {
    const client = makeClient("да");
    expect(await classifyMessageOpenAI("spam text", client)).toBe(true);
  });

  it('returns true for answer with surrounding whitespace ("  Да  ")', async () => {
    const client = makeClient("  Да  ");
    expect(await classifyMessageOpenAI("spam", client)).toBe(true);
  });

  it('returns false when OpenAI answers "нет"', async () => {
    const client = makeClient("нет");
    expect(await classifyMessageOpenAI("normal text", client)).toBe(false);
  });

  it("returns false when answer is null", async () => {
    const client = makeClient(null);
    expect(await classifyMessageOpenAI("text", client)).toBe(false);
  });

  it("returns false (safe default) when OpenAI throws", async () => {
    const client = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("network error")),
        },
      },
    } as unknown as OpenAI;
    expect(await classifyMessageOpenAI("text", client)).toBe(false);
  });

  it("sends the message text inside the prompt", async () => {
    const client = makeClient("нет");
    await classifyMessageOpenAI("unique-test-message-xyz", client);
    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userMessage = call.messages.find((m: { role: string }) => m.role === "user");
    expect(userMessage.content).toContain("unique-test-message-xyz");
  });
});
