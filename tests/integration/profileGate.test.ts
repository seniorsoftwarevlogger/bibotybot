/**
 * Integration tests for the account profile gate: a real Telegraf bot, MSW
 * intercepting the Bot API (including the avatar download), and the model
 * injected as a stub.
 *
 * MongoDB and OpenAI are plain stubs — no network beyond MSW.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Telegraf } from "telegraf";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { Collection, Db } from "mongodb";

import { getLevel, initPermissions, THRESHOLDS } from "../../src/permissions.ts";
import {
  initProfileGate,
  setupProfileGate,
  type AccountCheckDoc,
} from "../../src/profileGate.ts";
import type { ProfileFlags } from "../../src/profileClassifier.ts";

const TOKEN = "111222333:TestBotToken_MSW";
const CHAT_ID = -1001234567890;
const MSG_ID = 100;

const GROUP_PERMISSIONS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
};

// A profile the way getChat(user_id) returns it. Tests register one per user
// id; an unregistered id answers "chat not found", like a user the bot shares no
// chat with.
type ProfileFixture = {
  bio?: string;
  personal_chat?: { id: number; title: string; username?: string };
  rating?: { level: number; rating: number };
  photo?: { big_file_id: string; big_file_unique_id: string };
};

const profiles = new Map<number, ProfileFixture>();
const capturedCalls: { method: string; body: Record<string, unknown> }[] = [];
const AVATAR = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

const server = setupServer(
  http.post(`https://api.telegram.org/bot${TOKEN}/:method`, async ({ params, request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const method = params.method as string;
    capturedCalls.push({ method, body });

    if (method === "getChat") {
      const chatId = Number(body.chat_id);
      if (chatId > 0) {
        const profile = profiles.get(chatId);
        if (!profile) {
          return HttpResponse.json({
            ok: false,
            error_code: 400,
            description: "Bad Request: chat not found",
          });
        }
        return HttpResponse.json({
          ok: true,
          result: { id: chatId, type: "private", first_name: "Test", ...profile },
        });
      }
      return HttpResponse.json({
        ok: true,
        result: { id: CHAT_ID, type: "supergroup", permissions: GROUP_PERMISSIONS },
      });
    }
    if (method === "getFile") {
      return HttpResponse.json({
        ok: true,
        result: {
          file_id: body.file_id,
          file_unique_id: "unique",
          file_path: "photos/avatar.jpg",
        },
      });
    }
    if (method === "copyMessage") {
      return HttpResponse.json({ ok: true, result: { message_id: 999 } });
    }
    if (method === "sendMessage") {
      return HttpResponse.json({ ok: true, result: { message_id: 998 } });
    }
    return HttpResponse.json({ ok: true, result: true });
  }),
  http.get(`https://api.telegram.org/file/bot${TOKEN}/*`, () =>
    HttpResponse.arrayBuffer(new Uint8Array(AVATAR), {
      headers: { "content-type": "image/jpeg" },
    })
  )
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  capturedCalls.length = 0;
  profiles.clear();
  server.resetHandlers();
});

function methods() {
  return capturedCalls.map((call) => call.method);
}

function find(method: string) {
  return capturedCalls.find((call) => call.method === method);
}

// deleteMessage hands the mod-log notice to notifyModAction without awaiting it,
// so give in-flight calls a tick before asserting on them.
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function flags(overrides: Partial<ProfileFlags> = {}): ProfileFlags {
  return {
    intimate_offer: false,
    seductive_avatar: false,
    stock_or_ai_avatar: false,
    bio_external_cta: false,
    bio_earnings_or_crypto: false,
    looks_like_real_person: false,
    confidence: 0.9,
    refused: false,
    model: "gpt-4o-mini",
    tokens: { input: 2850, output: 60 },
    latencyMs: 1200,
    ...overrides,
  };
}

function accountDoc(userId: number, overrides: Partial<AccountCheckDoc> = {}): AccountCheckDoc {
  const now = Date.now();
  return {
    user_id: userId,
    verdict: "clean",
    score: 0,
    signals: [],
    reasons: [],
    profile: {
      first_name: "Test",
      username: null,
      bio: null,
      personal_chat: null,
      rating_level: null,
      photo_unique_id: null,
    },
    flags: null,
    checked_at: new Date(now),
    recheck_after: new Date(now + 30 * 24 * 60 * 60 * 1000),
    action_taken: false,
    admin_cleared: false,
    cleared_by: null,
    ...overrides,
  };
}

function makeDbStub(messageCount: number, stored: AccountCheckDoc | null) {
  const statistics = {
    findOne: vi.fn().mockResolvedValue(messageCount > 0 ? { messages: messageCount } : null),
  } as unknown as Collection<any>;
  const accountChecks = {
    findOne: vi.fn().mockResolvedValue(stored),
    updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
  } as unknown as Collection<AccountCheckDoc>;

  const db = {
    collection: (name: string) => (name === "account_checks" ? accountChecks : statistics),
  } as unknown as Db;

  return { db, accountChecks };
}

/** Mirrors index.ts: level middleware, then the profile gate, then the rest. */
function buildBot(opts: {
  messageCount?: number;
  verdict?: ProfileFlags | null;
  stored?: AccountCheckDoc | null;
}) {
  const store = makeDbStub(opts.messageCount ?? 0, opts.stored ?? null);
  initPermissions(store.db);
  initProfileGate(store.db);

  const classify = vi.fn().mockResolvedValue(opts.verdict === undefined ? flags() : opts.verdict);
  const reached: number[] = [];
  const bot = new Telegraf(TOKEN);

  bot.use(async (ctx, next) => {
    const id = ctx.message?.from?.id;
    const chatId = ctx.chat?.id;
    if (id && chatId && ctx.message) {
      ctx.state = { ...ctx.state, level: await getLevel(chatId, id), boosted: false };
    }
    return next();
  });

  setupProfileGate(bot, { family: () => [], classify, checkTimeoutMs: 500 });
  bot.use(async (ctx) => {
    if (ctx.message) reached.push(ctx.message.message_id);
  });

  return { bot, classify, reached, store };
}

function makeTextUpdate(userId: number, text = "Привет, как дела?") {
  return {
    update_id: 1,
    message: {
      message_id: MSG_ID,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: "supergroup" },
      from: { id: userId, is_bot: false, first_name: "Test" },
      text,
    },
  } as any;
}

function makeJoinUpdate(userId: number) {
  const user = { id: userId, is_bot: false, first_name: "Test" };
  return {
    update_id: 2,
    chat_member: {
      chat: { id: CHAT_ID, type: "supergroup", title: "Chat" },
      from: { id: 55501, is_bot: false, first_name: "Inviter" },
      date: Math.floor(Date.now() / 1000),
      old_chat_member: { status: "left", user },
      new_chat_member: { status: "member", user },
    },
  } as any;
}

const BOT_PROFILE: ProfileFixture = {
  bio: "Скучаю тут одна, пиши в лс 🔞",
  personal_chat: { id: -100999, title: "Мой приватный канал", username: "private_xxx" },
  rating: { level: -2, rating: -140 },
  photo: { big_file_id: "avatar-1", big_file_unique_id: "avatar-uniq-1" },
};

const BOT_FLAGS = {
  intimate_offer: true,
  bio_external_cta: true,
  seductive_avatar: true,
};

// Sells something, but has no personal channel and a neutral Telegram rating:
// suspicious, and left for the join gate's captcha rather than restricted.
const BORDERLINE_PROFILE: ProfileFixture = {
  bio: "Скучаю тут одна, пиши в лс",
  photo: { big_file_id: "avatar-2", big_file_unique_id: "avatar-uniq-2" },
};

const BORDERLINE_FLAGS = { intimate_offer: true, seductive_avatar: true };

describe("profile gate on a message", () => {
  it("quarantines and restricts an account that looks like a bot", async () => {
    const userId = 21001;
    profiles.set(userId, BOT_PROFILE);
    const { bot, reached } = buildBot({ verdict: flags(BOT_FLAGS) });

    await bot.handleUpdate(makeTextUpdate(userId));
    await settle();

    expect(reached).toEqual([]);
    expect(find("copyMessage")).toBeDefined();
    expect(find("deleteMessage")).toBeDefined();

    const restrict = find("restrictChatMember");
    expect(restrict?.body.user_id).toBe(userId);
    expect(restrict?.body.permissions).toMatchObject({ can_send_messages: false });
    expect(restrict?.body.until_date).toBeUndefined();

    const modLog = capturedCalls.find(
      (call) =>
        call.method === "sendMessage" && String(call.body.text).startsWith("🚫")
    );
    expect(modLog?.body.text).toContain("профиль похож на бота");
    expect(modLog?.body.text).toContain("предложение интимного контента");
    expect(modLog?.body.reply_markup).toBeDefined();
  });

  it("sends the avatar to the model and stores the verdict", async () => {
    const userId = 21002;
    profiles.set(userId, BOT_PROFILE);
    const { bot, classify, store } = buildBot({ verdict: flags(BOT_FLAGS) });

    await bot.handleUpdate(makeTextUpdate(userId));

    expect(methods()).toContain("getFile");
    const input = classify.mock.calls[0][0];
    expect(input.bio).toBe(BOT_PROFILE.bio);
    expect(input.personalChat).toEqual(BOT_PROFILE.personal_chat);
    expect(input.avatarBase64).toBe(AVATAR.toString("base64"));

    expect(store.accountChecks.updateOne).toHaveBeenCalledTimes(1);
    const saved = (store.accountChecks.updateOne as any).mock.calls[0][1].$set;
    expect(saved.verdict).toBe("bot");
    expect(saved.profile.rating_level).toBe(-2);
    expect(saved.profile.photo_unique_id).toBe("avatar-uniq-1");
  });

  it("lets a clean profile through to the next gate", async () => {
    const userId = 21003;
    profiles.set(userId, { photo: { big_file_id: "a", big_file_unique_id: "u" } });
    const { bot, reached } = buildBot({ verdict: flags({ looks_like_real_person: true }) });

    await bot.handleUpdate(makeTextUpdate(userId));

    expect(reached).toEqual([MSG_ID]);
    expect(methods()).not.toContain("restrictChatMember");
    expect(methods()).not.toContain("copyMessage");
  });

  it("leaves a borderline profile to the join gate instead of restricting it", async () => {
    const userId = 21004;
    profiles.set(userId, BORDERLINE_PROFILE);
    const { bot, reached } = buildBot({ verdict: flags(BORDERLINE_FLAGS) });

    await bot.handleUpdate(makeTextUpdate(userId));

    expect(reached).toEqual([MSG_ID]);
    expect(methods()).not.toContain("restrictChatMember");
  });

  it("judges an account once, not once per message", async () => {
    const userId = 21005;
    profiles.set(userId, { photo: { big_file_id: "a", big_file_unique_id: "u" } });
    const { bot, classify } = buildBot({});

    await bot.handleUpdate(makeTextUpdate(userId));
    await bot.handleUpdate(makeTextUpdate(userId));

    expect(classify).toHaveBeenCalledTimes(1);
    expect(methods().filter((method) => method === "getChat")).toHaveLength(1);
  });

  it("reuses the stored verdict after a restart without touching Telegram", async () => {
    const userId = 21006;
    const stored = accountDoc(userId, {
      verdict: "bot",
      score: 0.95,
      reasons: ["предложение интимного контента"],
    });
    const { bot, classify, reached } = buildBot({ stored });

    await bot.handleUpdate(makeTextUpdate(userId));
    await settle();

    expect(classify).not.toHaveBeenCalled();
    expect(methods()).not.toContain("getChat");
    expect(reached).toEqual([]);
    expect(find("restrictChatMember")?.body.user_id).toBe(userId);
  });

  it("does not re-judge an account an admin vouched for", async () => {
    const userId = 21007;
    profiles.set(userId, BOT_PROFILE);
    const stored = accountDoc(userId, {
      score: 0.95,
      reasons: ["предложение интимного контента"],
      admin_cleared: true,
      cleared_by: 55501,
      recheck_after: new Date(Date.now() - 1000),
    });
    const { bot, classify, reached } = buildBot({ verdict: flags(BOT_FLAGS), stored });

    await bot.handleUpdate(makeTextUpdate(userId));

    expect(reached).toEqual([MSG_ID]);
    expect(classify).not.toHaveBeenCalled();
    expect(methods()).not.toContain("restrictChatMember");
  });

  it("skips members who are past the reaction threshold", async () => {
    const userId = 21008;
    profiles.set(userId, BOT_PROFILE);
    const { bot, classify, reached } = buildBot({
      messageCount: THRESHOLDS.react,
      verdict: flags(BOT_FLAGS),
    });

    await bot.handleUpdate(makeTextUpdate(userId));

    expect(reached).toEqual([MSG_ID]);
    expect(classify).not.toHaveBeenCalled();
    expect(methods()).not.toContain("getChat");
  });

  it("fails open when the model is unavailable", async () => {
    const userId = 21009;
    profiles.set(userId, BOT_PROFILE);
    const { bot, reached } = buildBot({ verdict: null });

    await bot.handleUpdate(makeTextUpdate(userId));

    expect(reached).toEqual([MSG_ID]);
    expect(methods()).not.toContain("restrictChatMember");
  });

  it("fails open when Telegram hides the profile", async () => {
    const userId = 21010; // no fixture registered: getChat answers "chat not found"
    const { bot, classify, reached } = buildBot({ verdict: flags(BOT_FLAGS) });

    await bot.handleUpdate(makeTextUpdate(userId));

    expect(reached).toEqual([MSG_ID]);
    expect(classify).not.toHaveBeenCalled();
    expect(methods()).not.toContain("restrictChatMember");
  });

  it("judges a profile with no avatar from its text alone", async () => {
    const userId = 21011;
    profiles.set(userId, { bio: "Заработок от 500$ в день, пиши в лс" });
    const { bot, classify } = buildBot({
      verdict: flags({ bio_external_cta: true, bio_earnings_or_crypto: true }),
    });

    await bot.handleUpdate(makeTextUpdate(userId));

    expect(classify.mock.calls[0][0].avatarBase64).toBeNull();
    expect(methods()).not.toContain("getFile");
  });

  it("ignores service messages", async () => {
    const userId = 21012;
    const { bot, classify } = buildBot({});

    await bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: MSG_ID + 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT_ID, type: "supergroup" },
        from: { id: userId, is_bot: false, first_name: "Test" },
        new_chat_members: [{ id: userId, is_bot: false, first_name: "Test" }],
      },
    } as any);

    expect(classify).not.toHaveBeenCalled();
    expect(methods()).not.toContain("getChat");
  });
});

describe("profile gate on a join", () => {
  it("restricts a confident bot as it joins", async () => {
    const userId = 21020;
    profiles.set(userId, BOT_PROFILE);
    const { bot, classify } = buildBot({ verdict: flags(BOT_FLAGS) });

    await bot.handleUpdate(makeJoinUpdate(userId));
    await settle();

    expect(classify).toHaveBeenCalledTimes(1);
    expect(find("restrictChatMember")?.body.user_id).toBe(userId);

    const modLog = capturedCalls.find(
      (call) => call.method === "sendMessage" && String(call.body.text).includes("🚫")
    );
    expect(modLog?.body.text).toContain(String(userId));
    expect(modLog?.body.reply_markup).toBeDefined();
  });

  it("leaves a borderline joiner for the captcha", async () => {
    const userId = 21021;
    profiles.set(userId, BORDERLINE_PROFILE);
    const { bot } = buildBot({ verdict: flags(BORDERLINE_FLAGS) });

    await bot.handleUpdate(makeJoinUpdate(userId));

    expect(methods()).not.toContain("restrictChatMember");
  });

  it("does not judge a leaving member", async () => {
    const userId = 21022;
    profiles.set(userId, BOT_PROFILE);
    const { bot, classify } = buildBot({ verdict: flags(BOT_FLAGS) });

    await bot.handleUpdate({
      ...makeJoinUpdate(userId),
      chat_member: {
        ...makeJoinUpdate(userId).chat_member,
        old_chat_member: { status: "member", user: { id: userId, is_bot: false, first_name: "Test" } },
        new_chat_member: { status: "left", user: { id: userId, is_bot: false, first_name: "Test" } },
      },
    } as any);

    expect(classify).not.toHaveBeenCalled();
    expect(methods()).not.toContain("getChat");
  });
});
