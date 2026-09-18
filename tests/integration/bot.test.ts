/**
 * Integration tests: assembles a Telegraf bot from the real middleware modules
 * and uses MSW to intercept outbound Telegram Bot API HTTP calls.
 *
 * OpenAI and MongoDB are injected as plain stubs — no network needed.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { Telegraf } from "telegraf";
import { anyOf, message } from "telegraf/filters";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import type { OpenAI } from "openai";
import type { Collection, Db } from "mongodb";

import { classifyMessageOpenAI } from "../../src/openaiClassifier.ts";
import { getLevel, initPermissions, invalidate, THRESHOLDS } from "../../src/permissions.ts";
import { blockUser, deleteMediaMessage, deleteMessage, muteFor24h } from "../../src/lib.ts";
import { hasLinks } from "../../src/helpers.ts";
import { initPromote, rememberUser, setupPromote } from "../../src/promote.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const TOKEN = "111222333:TestBotToken_MSW";
const CHAT_ID = -1001234567890;
const MSG_ID = 100;
const ADMIN_ID = 777;

// ── MSW Telegram Bot API stub ─────────────────────────────────────────────────

const capturedCalls: { method: string; body: Record<string, unknown> }[] = [];

const server = setupServer(
  http.post(
    `https://api.telegram.org/bot${TOKEN}/:method`,
    async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      capturedCalls.push({ method: params.method as string, body });

      if (params.method === "copyMessage") {
        return HttpResponse.json({ ok: true, result: { message_id: 999 } });
      }
      if (params.method === "getChatMember") {
        const status = body.user_id === ADMIN_ID ? "administrator" : "member";
        return HttpResponse.json({
          ok: true,
          result: { status, user: { id: body.user_id, is_bot: false, first_name: "U", username: `u${body.user_id}` } },
        });
      }
      if (params.method === "sendMessage") {
        return HttpResponse.json({ ok: true, result: { message_id: 998 } });
      }
      return HttpResponse.json({ ok: true, result: true });
    }
  )
);

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterAll(() => server.close());
beforeEach(() => {
  capturedCalls.length = 0;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOpenAIStub(isSpam: boolean): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: isSpam ? "да" : "нет" } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

function makeDbStub(messageCount: number): Db {
  const doc = messageCount > 0 ? { messages: messageCount } : null;
  const col = { findOne: vi.fn().mockResolvedValue(doc) } as unknown as Collection<any>;
  return { collection: () => col } as unknown as Db;
}

function calledMethods() {
  return capturedCalls.map((c) => c.method);
}

/**
 * Build a minimal Telegraf bot that mirrors the key middleware from index.ts.
 * Each call produces an isolated instance — safe to run concurrently.
 */
function buildBot(opts: {
  userId: number;
  messageCount: number;
  isSpam: boolean;
}) {
  const { userId, messageCount, isSpam } = opts;

  initPermissions(makeDbStub(messageCount));
  const openAIStub = makeOpenAIStub(isSpam);

  const bot = new Telegraf(TOKEN);

  // ── middleware 1: resolve level into ctx.state ───────────────────────────
  bot.use(async (ctx, next) => {
    const id = ctx.message?.from?.id;
    const chatId = ctx.chat?.id;
    if (id && chatId && ctx.message) {
      const level = await getLevel(chatId, id);
      ctx.state = { ...ctx.state, level, boosted: false };
    }
    return next();
  });

  // ── middleware 2: link filter ────────────────────────────────────────────
  bot.on(message("text"), async (ctx, next) => {
    if (!hasLinks(ctx)) return next();
    if (ctx.state?.boosted || ctx.state?.level?.canLink) return next();
    await deleteMessage(ctx, "No links for you.");
  });

  // ── middleware 3: spam filter ────────────────────────────────────────────
  bot.on(message("text"), async (ctx, next) => {
    const spam = await classifyMessageOpenAI(ctx.message.text, openAIStub);
    if (!spam) return next();
    await Promise.all([
      blockUser(ctx.telegram, ctx.chat.id, ctx.message.from.id).catch(() => {}),
      deleteMessage(ctx, "Spam removed."),
    ]);
  });

  // ── middleware 4: media filter ───────────────────────────────────────────
  bot.on(
    anyOf(message("photo"), message("video"), message("document"), message("sticker")),
    async (ctx) => {
      if (ctx.state?.boosted || ctx.state?.level?.canMedia) return;
      await deleteMediaMessage(ctx);
    }
  );

  return bot;
}

function makeTextUpdate(
  userId: number,
  text: string,
  entities?: { type: string; offset: number; length: number }[]
) {
  return {
    update_id: 1,
    message: {
      message_id: MSG_ID,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: "supergroup" },
      from: { id: userId, is_bot: false, first_name: "Test" },
      text,
      entities,
    },
  } as any;
}

function makePhotoUpdate(userId: number) {
  return {
    update_id: 2,
    message: {
      message_id: MSG_ID,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: "supergroup" },
      from: { id: userId, is_bot: false, first_name: "Test" },
      photo: [{ file_id: "abc", file_unique_id: "abc", width: 100, height: 100 }],
    },
  } as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("spam filter", () => {
  it("archives and deletes a spam message, then mutes the sender", async () => {
    const userId = 1001;
    const bot = buildBot({ userId, messageCount: 0, isSpam: true });

    await bot.handleUpdate(makeTextUpdate(userId, "Хочешь заработать от 500$ в день? Пиши в ЛС!"));

    expect(calledMethods()).toContain("copyMessage");
    expect(calledMethods()).toContain("deleteMessage");
    expect(calledMethods()).toContain("restrictChatMember");

    const copy = capturedCalls.find((c) => c.method === "copyMessage");
    expect(copy?.body.from_chat_id).toBe(CHAT_ID);
    expect(copy?.body.message_id).toBe(MSG_ID);

    // The "why it was removed" notice goes out as an ephemeral message that only
    // the offending user can see, addressed via receiver_user_id.
    const notice = capturedCalls.find((c) => c.method === "sendMessage");
    expect(notice?.body.receiver_user_id).toBe(userId);
    expect(notice?.body.text).toBe("Spam removed.");
  });

  it("lets a normal message pass without any restriction", async () => {
    const userId = 1002;
    const bot = buildBot({ userId, messageCount: 0, isSpam: false });

    await bot.handleUpdate(makeTextUpdate(userId, "Привет, как дела?"));

    expect(calledMethods()).not.toContain("restrictChatMember");
    expect(calledMethods()).not.toContain("deleteMessage");
  });
});

describe("link filter", () => {
  it("deletes and archives a link message from a user below the threshold", async () => {
    const userId = 2001;
    const bot = buildBot({ userId, messageCount: 0, isSpam: false });

    await bot.handleUpdate(
      makeTextUpdate(userId, "See https://example.com", [
        { type: "url", offset: 4, length: 19 },
      ])
    );

    expect(calledMethods()).toContain("copyMessage");
    expect(calledMethods()).toContain("deleteMessage");

    const notice = capturedCalls.find((c) => c.method === "sendMessage");
    expect(notice?.body.receiver_user_id).toBe(userId);
    expect(notice?.body.text).toBe("No links for you.");
  });

  it("allows a link message from a user who reached the link threshold", async () => {
    const userId = 2002;
    invalidate(CHAT_ID, userId);
    const bot = buildBot({ userId, messageCount: THRESHOLDS.link, isSpam: false });

    await bot.handleUpdate(
      makeTextUpdate(userId, "See https://example.com", [
        { type: "url", offset: 4, length: 19 },
      ])
    );

    expect(calledMethods()).not.toContain("copyMessage");
    expect(calledMethods()).not.toContain("deleteMessage");
  });

  it("does not trigger the link filter for plain text (no entities)", async () => {
    const userId = 2003;
    const bot = buildBot({ userId, messageCount: 0, isSpam: false });

    await bot.handleUpdate(makeTextUpdate(userId, "Just a normal message"));

    expect(calledMethods()).not.toContain("copyMessage");
  });
});

describe("media filter", () => {
  it("deletes a photo from a user below the media threshold", async () => {
    const userId = 3001;
    const bot = buildBot({ userId, messageCount: 0, isSpam: false });

    await bot.handleUpdate(makePhotoUpdate(userId));

    expect(calledMethods()).toContain("deleteMessage");
    expect(calledMethods()).toContain("sendMessage");
    expect(calledMethods()).toContain("restrictChatMember");

    // The removal notice is ephemeral: only the user who posted the media sees it,
    // so the group is not spammed with a public warning.
    const notice = capturedCalls.find((c) => c.method === "sendMessage");
    expect(notice?.body.receiver_user_id).toBe(userId);
  });

  it("allows a photo from a user who reached the media threshold", async () => {
    const userId = 3002;
    invalidate(CHAT_ID, userId);
    const bot = buildBot({ userId, messageCount: THRESHOLDS.media, isSpam: false });

    await bot.handleUpdate(makePhotoUpdate(userId));

    expect(calledMethods()).not.toContain("deleteMessage");
  });
});

describe("/promote", () => {
  const TARGET_ID = 4001;
  let overrideDoc: { messages: number } | null = null;

  function buildPromoteBot() {
    const stats = { findOne: vi.fn().mockResolvedValue({ messages: 2 }) };
    const overrides = {
      findOne: vi.fn(async () => overrideDoc),
      updateOne: vi.fn(async (_q: unknown, update: any) => {
        overrideDoc = { messages: update.$set.messages };
      }),
      deleteOne: vi.fn(async () => {
        overrideDoc = null;
      }),
    };
    const knownUsers = { findOne: vi.fn(async () => null), updateOne: vi.fn(async () => ({})) };
    initPermissions(
      { collection: () => stats } as unknown as Db,
      { collection: () => overrides } as unknown as Db
    );
    initPromote({ collection: () => knownUsers } as unknown as Db);

    const bot = new Telegraf(TOKEN);
    bot.botInfo = { id: 1, is_bot: true, first_name: "Bot", username: "bibotybot" } as any;
    const applyRankTag = vi.fn();
    bot.use((ctx, next) => {
      rememberUser(ctx.message?.from);
      return next();
    });
    setupPromote(bot, { myChannels: [], applyRankTag });
    const passedThrough = vi.fn();
    bot.use(passedThrough);
    return { bot, applyRankTag, passedThrough };
  }

  function commandUpdate(fromId: number, text: string, entities: any[]) {
    return {
      update_id: 10,
      message: {
        message_id: MSG_ID,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT_ID, type: "supergroup" },
        from: { id: fromId, is_bot: false, first_name: "Admin" },
        text,
        entities,
      },
    } as any;
  }

  function clickUpdate(fromId: number, data: string) {
    return {
      update_id: 11,
      callback_query: {
        id: "cb1",
        from: { id: fromId, is_bot: false, first_name: "X" },
        chat_instance: "1",
        data,
        message: {
          message_id: 998,
          date: 0,
          chat: { id: CHAT_ID, type: "supergroup" },
          text: "Уровень для @target",
        },
      },
    } as any;
  }

  beforeEach(() => {
    overrideDoc = null;
    invalidate(CHAT_ID, TARGET_ID);
  });

  it("shows rank buttons for an @username the bot has seen, and a click sets the rank", async () => {
    const { bot, applyRankTag } = buildPromoteBot();
    // The target posted before, so the bot knows @target's id.
    await bot.handleUpdate({
      update_id: 9,
      message: {
        message_id: 50,
        date: 0,
        chat: { id: CHAT_ID, type: "supergroup" },
        from: { id: TARGET_ID, is_bot: false, first_name: "T", username: "Target" },
        text: "hi",
      },
    } as any);
    capturedCalls.length = 0;

    await bot.handleUpdate(
      commandUpdate(ADMIN_ID, "/promote @target", [
        { type: "bot_command", offset: 0, length: 8 },
        { type: "mention", offset: 9, length: 7 },
      ])
    );

    const prompt = capturedCalls.find((c) => c.method === "sendMessage");
    const buttons = (prompt?.body.reply_markup as any).inline_keyboard.flat();
    expect(buttons.map((b: any) => b.callback_data)).toContain(`promote:${TARGET_ID}:MB`);
    expect(calledMethods()).toContain("deleteMessage"); // admin's command is cleaned up

    capturedCalls.length = 0;
    await bot.handleUpdate(clickUpdate(ADMIN_ID, `promote:${TARGET_ID}:MB`));

    expect(overrideDoc).toEqual({ messages: 50 });
    expect(applyRankTag).toHaveBeenCalledWith(CHAT_ID, TARGET_ID, "MB");
    const edit = capturedCalls.find((c) => c.method === "editMessageText");
    expect(edit?.body.text).toContain("MB");
  });

  it("ignores clicks from non-admins", async () => {
    const { bot, applyRankTag } = buildPromoteBot();

    await bot.handleUpdate(clickUpdate(5555, `promote:${TARGET_ID}:TB`));

    expect(overrideDoc).toBeNull();
    expect(applyRankTag).not.toHaveBeenCalled();
    const answer = capturedCalls.find((c) => c.method === "answerCallbackQuery");
    expect(answer?.body.show_alert).toBe(true);
  });

  it("lets /promote from a regular member fall through to the other filters", async () => {
    const { bot, passedThrough } = buildPromoteBot();

    await bot.handleUpdate(commandUpdate(5555, "/promote", []));

    expect(passedThrough).toHaveBeenCalled();
    expect(calledMethods()).not.toContain("sendMessage");
  });
});
