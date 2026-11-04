import type { Collection, Db } from "mongodb";
import type { Telegraf } from "telegraf";
import { CONTENT_FIELDS, isTelegramServiceUser } from "./helpers.ts";
import { joinEvent } from "./joinGate.ts";
import { blockUser, deleteMessage } from "./lib.ts";
import { notifyModAction } from "./modLog.ts";
import { THRESHOLDS } from "./permissions.ts";
import {
  classifyProfileOpenAI,
  type ProfileFlags,
  type ProfileInput,
} from "./profileClassifier.ts";

// Text spam that reads like a real comment gets past the message classifier, but
// the account behind it still gives itself away in the profile: a seductive
// avatar, a bio selling intimate content or a personal channel, a negative
// Telegram reliability rating. So every account nobody has seen before is judged
// once by its profile, before its words are judged at all.
//
// The check is expensive (one Bot API call, one image download, one vision call)
// and the answer does not change, so the verdict is stored in MongoDB and reused
// across restarts. That also fixes what the in-memory "good citizens" bloom
// filter could not: a restart no longer re-asks the model about everybody, and a
// verdict expires instead of being trusted forever.

export type Verdict = "clean" | "suspect" | "bot";

// A block needs a high score AND two independent signals, so that no single
// trait — a name, a pretty photo, a missing username, a model refusal — can
// block a live member on its own.
export const BAN_SCORE = 0.85;
export const MIN_BAN_SIGNALS = 2;
export const SUSPECT_SCORE = 0.5;

// Weight below which a signal is kept for audit but not shown as a reason: it is
// background noise ("no username"), not an accusation.
const STRONG_SIGNAL_WEIGHT = 0.2;
// A personal channel on its own means nothing; one that carries the same offer
// as the bio is the account's second storefront.
const PERSONAL_CHANNEL_OFFER_BONUS = 0.15;
// The model seeing an ordinary human should pull a borderline score back down.
const REAL_PERSON_DISCOUNT = 0.25;

const SIGNAL_WEIGHTS = {
  intimate_offer: 0.45,
  seductive_avatar: 0.3,
  bio_external_cta: 0.3,
  bio_earnings_or_crypto: 0.25,
  negative_rating: 0.25,
  refused_avatar: 0.25,
  stock_or_ai_avatar: 0.2,
  bot_like_name: 0.1,
  personal_channel: 0.05,
  no_username: 0.05,
} as const;

export type SignalName = keyof typeof SIGNAL_WEIGHTS;

const SIGNAL_LABELS: Record<SignalName, string> = {
  intimate_offer: "предложение интимного контента",
  seductive_avatar: "вызывающий аватар",
  bio_external_cta: "уводит в личку или на внешнюю площадку",
  bio_earnings_or_crypto: "обещание заработка или крипта",
  negative_rating: "отрицательный рейтинг надёжности Telegram",
  refused_avatar: "откровенный аватар",
  stock_or_ai_avatar: "аватар похож на сток или нейросеть",
  bot_like_name: "имя с цифрами, эмодзи или «18+»",
  personal_channel: "личный канал",
  no_username: "нет username",
};

const RECHECK_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
// Without a model answer the score can never reach the block threshold, so a
// failed call is remembered only briefly instead of whitelisting the account.
const MODEL_RETRY_AFTER_MS = 10 * 60 * 1000;
// A verdict must not hold up the first message forever, but it also should not
// give up too early: a real check measures ~3s (getChat + avatar download + a
// vision call), and failing open means the account stays unjudged. The join gate
// is holding this message behind a captcha anyway, so the wait is invisible.
const CHECK_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const CACHE_LIMIT = 50_000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
};

// The subset of ChatFullInfo a bot gets from getChat(user_id): bio, the personal
// channel, the Star-spending reliability rating and the profile photo.
type ProfileChat = {
  type?: string;
  bio?: string;
  personal_chat?: { id?: number; title?: string; username?: string } | null;
  rating?: { level?: number; rating?: number } | null;
  photo?: { big_file_id?: string; big_file_unique_id?: string } | null;
};

export type ProfileSignals = {
  hasUsername: boolean;
  hasBio: boolean;
  hasPersonalChat: boolean;
  ratingLevel: number | null;
  photoUniqueId: string | null;
  botLikeName: boolean;
};

export type AccountCheckDoc = {
  user_id: number;
  verdict: Verdict;
  score: number;
  signals: SignalName[];
  reasons: string[];
  // Evidence kept for audit and for re-checking after a profile change. Bios are
  // personal data, so this is what an admin reviews, not what the chat sees.
  profile: {
    first_name: string;
    username: string | null;
    bio: string | null;
    personal_chat: { title?: string; username?: string } | null;
    rating_level: number | null;
    photo_unique_id: string | null;
  };
  flags: ProfileFlags | null;
  checked_at: Date;
  recheck_after: Date;
  action_taken: boolean;
  // An admin pressed "Снять ограничения": this account is vouched for and is
  // never re-judged, otherwise the model would block it again on the spot.
  admin_cleared: boolean;
  cleared_by: number | null;
};

export type ClassifyProfile = (input: ProfileInput) => Promise<ProfileFlags | null>;

let accountChecks: Collection<AccountCheckDoc> | null = null;

const verdicts = new Map<number, AccountCheckDoc>();
// One check per account at a time: a burst of messages from a newcomer must not
// turn into a burst of vision calls.
const inflight = new Map<number, Promise<AccountCheckDoc | null>>();

export function initProfileGate(db: Db) {
  accountChecks = db.collection<AccountCheckDoc>("account_checks");
}

// Spam accounts pad their names with digits, emoji and "18+"; live people do not.
// Deliberately not a name-gender test — half of a live audience is women, and a
// woman's name is not a signal of anything.
export function nameLooksBot(name: string): boolean {
  return (
    /\d/.test(name) ||
    /18\s*\+|\+\s*18/i.test(name) ||
    /\p{Extended_Pictographic}/u.test(name) ||
    name.length > 40
  );
}

export function extractSignals(chat: ProfileChat, user: TelegramUser): ProfileSignals {
  return {
    hasUsername: !!user.username,
    hasBio: !!chat.bio?.trim(),
    hasPersonalChat: !!chat.personal_chat,
    ratingLevel: chat.rating?.level ?? null,
    photoUniqueId: chat.photo?.big_file_unique_id ?? null,
    botLikeName: nameLooksBot(
      [user.first_name, user.last_name, user.username].filter(Boolean).join(" ")
    ),
  };
}

export function scoreProfile(
  flags: ProfileFlags | null,
  signals: ProfileSignals
): { score: number; verdict: Verdict; signals: SignalName[]; reasons: string[] } {
  const matched: SignalName[] = [];
  const add = (name: SignalName, on: boolean | undefined) => {
    if (on) matched.push(name);
  };

  add("intimate_offer", flags?.intimate_offer);
  add("seductive_avatar", flags?.seductive_avatar);
  add("bio_external_cta", flags?.bio_external_cta);
  add("bio_earnings_or_crypto", flags?.bio_earnings_or_crypto);
  add("stock_or_ai_avatar", flags?.stock_or_ai_avatar);
  add("refused_avatar", flags?.refused);
  add("negative_rating", signals.ratingLevel !== null && signals.ratingLevel < 0);
  add("bot_like_name", signals.botLikeName);
  add("personal_channel", signals.hasPersonalChat);
  add("no_username", !signals.hasUsername);

  const offersSomething = flags?.bio_external_cta || flags?.intimate_offer;
  let score = matched.reduce((total, name) => total + SIGNAL_WEIGHTS[name], 0);
  if (signals.hasPersonalChat && offersSomething) score += PERSONAL_CHANNEL_OFFER_BONUS;
  if (flags?.looks_like_real_person) score -= REAL_PERSON_DISCOUNT;
  score = Math.max(0, Math.min(1, score));

  const verdict: Verdict =
    score >= BAN_SCORE && matched.length >= MIN_BAN_SIGNALS
      ? "bot"
      : score >= SUSPECT_SCORE
        ? "suspect"
        : "clean";

  const reasons = matched
    .filter((name) => SIGNAL_WEIGHTS[name] >= STRONG_SIGNAL_WEIGHT)
    .map((name) => SIGNAL_LABELS[name]);

  return { score, verdict, signals: matched, reasons };
}

function isFresh(doc: AccountCheckDoc): boolean {
  return !!doc.admin_cleared || doc.recheck_after.getTime() > Date.now();
}

async function loadDoc(userId: number): Promise<AccountCheckDoc | null> {
  if (!accountChecks) return null;
  try {
    return await accountChecks.findOne({ user_id: userId });
  } catch (error) {
    console.error(`profileGate: failed to read verdict for ${userId}`, error);
    return null;
  }
}

async function saveDoc(doc: AccountCheckDoc): Promise<void> {
  if (!accountChecks) return;
  try {
    await accountChecks.updateOne(
      { user_id: doc.user_id },
      { $set: doc },
      { upsert: true }
    );
  } catch (error) {
    console.error(`profileGate: failed to store verdict for ${doc.user_id}`, error);
  }
}

async function fetchAvatar(
  telegram: Telegraf["telegram"],
  fileId?: string
): Promise<string | null> {
  if (!fileId) return null;
  try {
    const link = await telegram.getFileLink(fileId);
    const response = await fetch(link, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_AVATAR_BYTES) return null;
    return buffer.toString("base64");
  } catch (error) {
    console.error("profileGate: failed to download the avatar:", error);
    return null;
  }
}

// getChat only answers for users the bot shares a chat with — anybody else is a
// 400 "chat not found". That is not evidence against them, so no data means no
// verdict and no cache entry: the next message tries again.
async function fetchProfile(
  telegram: Telegraf["telegram"],
  userId: number
): Promise<{ chat: ProfileChat; avatarBase64: string | null } | null> {
  const chat = (await telegram.getChat(userId).catch((error) => {
    console.error(`profileGate: getChat(${userId}) failed:`, error);
    return null;
  })) as ProfileChat | null;
  if (!chat || chat.type !== "private") return null;

  return { chat, avatarBase64: await fetchAvatar(telegram, chat.photo?.big_file_id) };
}

async function runCheck(
  telegram: Telegraf["telegram"],
  user: TelegramUser,
  classify: ClassifyProfile
): Promise<AccountCheckDoc | null> {
  const cached = verdicts.get(user.id) ?? (await loadDoc(user.id));
  if (cached && isFresh(cached)) {
    verdicts.set(user.id, cached);
    return cached;
  }

  const profile = await fetchProfile(telegram, user.id);
  if (!profile) return null;

  const flags = await classify({
    firstName: user.first_name,
    lastName: user.last_name ?? null,
    username: user.username ?? null,
    bio: profile.chat.bio ?? null,
    personalChat: profile.chat.personal_chat ?? null,
    avatarBase64: profile.avatarBase64,
  });

  const signals = extractSignals(profile.chat, user);
  const score = scoreProfile(flags, signals);
  const now = Date.now();
  const doc: AccountCheckDoc = {
    user_id: user.id,
    verdict: score.verdict,
    score: score.score,
    signals: score.signals,
    reasons: score.reasons,
    profile: {
      first_name: user.first_name,
      username: user.username ?? null,
      bio: profile.chat.bio ?? null,
      personal_chat: profile.chat.personal_chat ?? null,
      rating_level: signals.ratingLevel,
      photo_unique_id: signals.photoUniqueId,
    },
    flags,
    checked_at: new Date(now),
    recheck_after: new Date(now + (flags ? RECHECK_AFTER_MS : MODEL_RETRY_AFTER_MS)),
    action_taken: false,
    admin_cleared: false,
    cleared_by: null,
  };

  if (verdicts.size >= CACHE_LIMIT) verdicts.clear();
  verdicts.set(user.id, doc);
  await saveDoc(doc);

  console.log(
    JSON.stringify({
      event: "profile_check",
      userId: user.id,
      verdict: doc.verdict,
      score: Number(doc.score.toFixed(2)),
      signals: doc.signals,
      bio: doc.profile.bio?.slice(0, 200) ?? null,
      personalChat: doc.profile.personal_chat?.title ?? null,
      ratingLevel: doc.profile.rating_level,
      avatar: profile.avatarBase64 ? "yes" : "no",
      refused: flags?.refused ?? null,
      latencyMs: flags?.latencyMs ?? null,
      tokens: flags ? flags.tokens.input + flags.tokens.output : null,
    })
  );

  return doc;
}

/**
 * Verdict for this account, computed once and cached. Returns null when there
 * was nothing to judge — unknown user, no profile access, model unavailable.
 */
export function checkAccount(
  telegram: Telegraf["telegram"],
  user: TelegramUser,
  classify: ClassifyProfile = classifyProfileOpenAI
): Promise<AccountCheckDoc | null> {
  const running = inflight.get(user.id);
  if (running) return running;

  const check = runCheck(telegram, user, classify)
    .catch((error) => {
      console.error(`profileGate: check for ${user.id} failed:`, error);
      return null;
    })
    .finally(() => inflight.delete(user.id));

  inflight.set(user.id, check);
  return check;
}

// Racing, not cancelling: a check that outlives the timeout still stores its
// verdict, so the account's next message is judged by it.
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function blockReason(doc: AccountCheckDoc): string {
  const reasons = doc.reasons.length ? `: ${doc.reasons.join("; ")}` : "";
  return `Аккаунт заблокирован, профиль похож на бота${reasons}. Если это ошибка — напишите администратору чата.`;
}

/**
 * Records an admin's override, keeping the evidence of what the check saw. The
 * account is treated as clean from now on and is never re-judged: the profile
 * has not changed, so the model would only reach the same verdict again.
 */
export async function clearAccount(userId: number, adminId: number): Promise<void> {
  const previous = verdicts.get(userId) ?? (await loadDoc(userId));
  const now = new Date();
  const doc: AccountCheckDoc = previous
    ? { ...previous, verdict: "clean", checked_at: now, admin_cleared: true, cleared_by: adminId }
    : {
        user_id: userId,
        verdict: "clean",
        score: 0,
        signals: [],
        reasons: [],
        profile: {
          first_name: "",
          username: null,
          bio: null,
          personal_chat: null,
          rating_level: null,
          photo_unique_id: null,
        },
        flags: null,
        checked_at: now,
        recheck_after: now,
        action_taken: false,
        admin_cleared: true,
        cleared_by: adminId,
      };

  verdicts.set(userId, doc);
  await saveDoc(doc);
  console.log(`profileGate: ${adminId} cleared ${userId}`);
}

export function setupProfileGate(
  bot: Telegraf,
  {
    family,
    classify = classifyProfileOpenAI,
    checkTimeoutMs = CHECK_TIMEOUT_MS,
  }: {
    family: () => string[];
    classify?: ClassifyProfile;
    checkTimeoutMs?: number;
  }
) {
  // Registered before the join gate in index.ts: a blocked account must not be
  // greeted with a captcha banner it can never use, and a clean one must reach
  // the captcha with its verdict already cached.
  bot.use(async (ctx, next) => {
    const message = ctx.message;
    if (!message || !ctx.chat) return next();

    const user = message.from as TelegramUser | undefined;
    if (!user || user.is_bot || message.sender_chat) return next();
    if (isTelegramServiceUser(user)) return next();
    if (!CONTENT_FIELDS.some((field) => field in message)) return next();
    if (user.username && family().includes(user.username)) return next();
    // Established members are not new accounts; the level middleware above has
    // already counted their messages.
    if (ctx.state?.boosted) return next();
    if ((ctx.state?.level?.messageCount ?? 0) >= THRESHOLDS.react) return next();

    const doc = await withTimeout(checkAccount(ctx.telegram, user, classify), checkTimeoutMs);
    if (doc?.verdict !== "bot") return next();

    console.log(
      `profileGate: blocking ${user.id} in ${ctx.chat.id} (score ${doc.score.toFixed(2)})`
    );
    await deleteMessage(ctx, blockReason(doc));
  });

  // Judge a newcomer at the join, so the verdict is ready by their first message
  // and an account that only ever lurks is still stopped. Only a confident "bot"
  // is restricted here — the borderline band is left to the join gate's captcha,
  // which a live member can pass alone.
  bot.on("chat_member", async (ctx, next) => {
    const update = ctx.update.chat_member as
      | {
          chat: { id: number; title?: string };
          old_chat_member?: { status: string };
          new_chat_member: { status: string; user: TelegramUser };
        }
      | undefined;
    if (!update) return next();

    const user = update.new_chat_member.user;
    if (user.is_bot) return next();
    if (user.username && family().includes(user.username)) return next();
    if (
      joinEvent(update.new_chat_member.status, update.old_chat_member?.status) !== "join"
    ) {
      return next();
    }

    const doc = await checkAccount(ctx.telegram, user, classify);
    if (doc?.verdict !== "bot") return next();

    const chatId = update.chat.id;
    console.log(`profileGate: restricting joiner ${user.id} in ${chatId}`);
    doc.action_taken = true;
    await blockUser(ctx.telegram, chatId, user.id).catch((error) => {
      console.error(`profileGate: failed to restrict ${user.id} in ${chatId}:`, error);
    });
    await notifyModAction(ctx.telegram, {
      action: "block",
      target: {
        kind: "user",
        id: user.id,
        first_name: user.first_name,
        username: user.username,
      },
      chatId,
      chatTitle: update.chat.title,
      reason: blockReason(doc),
    });
    return next();
  });

  // Drop verdicts that are due for a re-check, so the map stays bounded and a
  // changed avatar is eventually seen again.
  const sweep = setInterval(() => {
    for (const [userId, doc] of verdicts) {
      if (!isFresh(doc)) verdicts.delete(userId);
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref();
}
