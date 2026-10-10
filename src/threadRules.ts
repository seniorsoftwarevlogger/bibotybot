import type { Collection, Db } from "mongodb";
import type { Telegraf } from "telegraf";
import { isAdmin } from "./promote.ts";

// Admins can exempt a whole discussion thread (the comments under one channel
// post) from the link and media gates: in an announcement or a vacancy thread
// the message-count thresholds only get in the way. A thread is identified by
// `message_thread_id`, which Telegram sets on every comment in the thread.
//
// Rules live in Mongo and are loaded into memory at startup, so the gates check
// them synchronously on every message. Only threads an admin marked are in the
// map — a miss means "no rule", never a lookup that has to hit the database.

export type ThreadPermission = "links" | "media";

export type ThreadRule = {
  links: boolean;
  media: boolean;
};

export const THREAD_RULE_COMMANDS: Record<
  string,
  { permission: ThreadPermission; allow: boolean }
> = {
  allow_links: { permission: "links", allow: true },
  allow_media: { permission: "media", allow: true },
  disallow_links: { permission: "links", allow: false },
  disallow_media: { permission: "media", allow: false },
};

export const NO_THREAD_HINT =
  "Эта команда работает только в треде обсуждения: напишите её в комментариях к посту, а не в основном чате.";

const RESULT_TTL_MS = 15_000;
const EMPTY_RULE: ThreadRule = { links: false, media: false };

type ThreadRuleDoc = {
  chat_id: number;
  thread_id: number;
  allow_links: boolean;
  allow_media: boolean;
  set_by: number;
  updated_at: Date;
};

let threadRules: Collection<ThreadRuleDoc> | null = null;
const rules = new Map<string, ThreadRule>();

function ruleKey(chatId: number, threadId: number) {
  return `${chatId}:${threadId}`;
}

export function initThreadRules(db: Db): Promise<void> {
  threadRules = db.collection<ThreadRuleDoc>("thread_rules");

  return threadRules
    .find({})
    .toArray()
    .then((docs) => {
      for (const doc of docs) {
        rules.set(ruleKey(doc.chat_id, doc.thread_id), {
          links: Boolean(doc.allow_links),
          media: Boolean(doc.allow_media),
        });
      }
      console.log(`threadRules: loaded ${rules.size} thread rules`);
    })
    .catch((error) => console.error("threadRules: failed to load rules", error));
}

export function threadAllows(
  chatId: number,
  threadId: number | undefined,
  permission: ThreadPermission
): boolean {
  if (!threadId) return false;
  return rules.get(ruleKey(chatId, threadId))?.[permission] ?? false;
}

// Memory first, database second: a failed write must not leave the rule
// unenforced for the rest of the process, so it stays in the map and is logged.
export async function setThreadRule(
  chatId: number,
  threadId: number,
  permission: ThreadPermission,
  allow: boolean,
  setBy: number
): Promise<ThreadRule> {
  const key = ruleKey(chatId, threadId);
  const rule = { ...EMPTY_RULE, ...rules.get(key), [permission]: allow };

  if (rule.links || rule.media) rules.set(key, rule);
  else rules.delete(key);

  const query = { chat_id: chatId, thread_id: threadId };
  try {
    if (rule.links || rule.media) {
      await threadRules?.updateOne(
        query,
        {
          $set: {
            allow_links: rule.links,
            allow_media: rule.media,
            set_by: setBy,
            updated_at: new Date(),
          },
        },
        { upsert: true }
      );
    } else {
      await threadRules?.deleteOne(query);
    }
  } catch (error) {
    console.error(`threadRules: failed to save rule for ${key}`, error);
  }

  return rule;
}

export function ruleText(
  rule: ThreadRule,
  permission: ThreadPermission,
  allow: boolean
): string {
  const what = permission === "links" ? "ссылки" : "медиа";
  const headline = allow
    ? `✅ В этом треде можно постить ${what}.`
    : `↩️ ${permission === "links" ? "Ссылки" : "Медиа"} в этом треде снова по общим правилам.`;
  const state = (allowed: boolean) => (allowed ? "можно" : "как обычно");
  return `${headline}\nСсылки: ${state(rule.links)}. Медиа: ${state(rule.media)}.`;
}

function deleteLater(
  telegram: Telegraf["telegram"],
  chatId: number,
  messageId: number
) {
  setTimeout(() => {
    telegram.deleteMessage(chatId, messageId).catch((error) => {
      console.log("CANT DELETE THREAD RULE MESSAGE:", messageId, error);
    });
  }, RESULT_TTL_MS);
}

export function setupThreadRules(
  bot: Telegraf,
  { myChannels }: { myChannels: string[] }
) {
  for (const [command, { permission, allow }] of Object.entries(
    THREAD_RULE_COMMANDS
  )) {
    bot.command(command, async (ctx, next) => {
      const chatId = ctx.chat.id;
      const message = ctx.message;

      const admin = await isAdmin(
        ctx.telegram,
        chatId,
        message.from,
        message.sender_chat as { id: number; username?: string } | undefined,
        myChannels
      );
      // For everyone else it's a regular message that still goes through the filters.
      if (!admin) return next();

      ctx.deleteMessage(message.message_id).catch(() => {});

      // ctx.reply only forwards the thread for forum topics (is_topic_message),
      // never for a channel post's comment thread — pass it explicitly or the
      // answer lands in the group's main chat, invisible to the admin.
      const threadId = message.message_thread_id;
      if (!threadId) {
        const sent = await ctx.reply(NO_THREAD_HINT);
        deleteLater(ctx.telegram, chatId, sent.message_id);
        return;
      }

      const setBy = message.from?.id ?? message.sender_chat?.id ?? 0;
      const rule = await setThreadRule(
        chatId,
        threadId,
        permission,
        allow,
        setBy
      );
      console.log(
        `threadRules: ${setBy} set ${permission}=${allow} for thread ${threadId} in ${chatId}`
      );

      const sent = await ctx.reply(ruleText(rule, permission, allow), {
        message_thread_id: threadId,
      });
      deleteLater(ctx.telegram, chatId, sent.message_id);
    });
  }
}
