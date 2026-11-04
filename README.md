# Cut the BS on Telegram

Simple bot that deletes t.me links from the channel posts.

### Start the bot

```
NODE_ENV=production BOT_TOKEN= PORT= node index.ts
```

It will be listening on:

```
http://<domain>:<PORT>/<BOT_TOKEN>
```

### Required ENV variables

```
BOT_TOKEN=
```

### Optional ENV variables

```
SENTRY_DSN=
MOD_CHAT_ID=        # chat for moderation-action notifications, defaults to @ssv_purge
```

### Spam classifier (Jev shadow mode)

The production spam decision is still made by the OpenAI classifier
(`src/openaiClassifier.ts`). In parallel every checked message is also sent to
TypeSafe's Jev model (`src/jevClassifier.ts`); the verdicts are only compared
and logged — as a `jev_shadow` JSON line in stdout and as a document in the
`jev_shadow` collection. Storing is best effort: if the Mongo user cannot write
to the database, the bot logs `jev_shadow_store_disabled` once and keeps
logging to stdout only.

```
TYPESAFE_API_KEY=       # without it shadow mode is silently disabled
JEV_MODEL=jev-latest
JEV_SPAM_THRESHOLD=0.5  # noul >= threshold means spam
JEV_TIMEOUT_MS=5000
JEV_SHADOW_DB=          # database for the jev_shadow collection, defaults to the one in MONGODB_URI
```

Check a single message manually:

```
npm run jev -- "текст сообщения"
```

## Features

1. **Join gate**: the gate only arms when someone joins (the `chat_member` update, or the "X joined the group" service message) and fires on the member's **first message**: the message is quarantined, the captcha — a reply in the same thread with the chat rules and a "Я не бот ✅" button — replaces it, and the member is restricted until they press the button. Replying in the same thread keeps the captcha visible in the channel discussion's comment UI, which is the only place a comments-only member ever looks. Further messages are held silently while the captcha is unanswered, though spam among them is still removed and blocked — being able to post at all means the restriction never landed; a pass restores the chat's default permissions and the captcha turns into a short-lived "Проверка пройдена" note. Nobody is ever kicked: members who never write are never touched, lurkers included. The gate is skipped for established members (5+ messages), the family, bots, and boosted members. A first message the spam classifier rejects never gets a banner at all: the gate hands it to the spam check first, so the message is removed, the sender blocked and the block logged, instead of leaving a captcha in the thread that nobody will ever press. The restriction self-expires, so a bot crash can never leave anyone muted forever.

2. **Edited messages are re-checked**: the link, spam, emoji and media gates run on edits too, so posting clean text and editing the links in afterwards no longer bypasses moderation.

3. **Mod log with one-click unban**: every automated restriction (block, 24h mute) is announced to the mod chat (`MOD_CHAT_ID`, defaults to `@ssv_purge`) with the user, chat, reason and a link to the quarantined copy. Notifications about users carry a "Снять ограничения" button — admins of the affected chat press it to lift the restriction; the message is then updated with who did it.

4. **Ban Replication**: when an admin bans a member in one of the managed chats (via the Telegram UI), the ban is automatically replicated to the other managed chats.

5. **Ephemeral removal notices**: When the bot removes a user's message (spam, links, media, etc.), it tells that user *why* using a Telegram [ephemeral message](https://core.telegram.org/bots/features#ephemeral-messages) — a group message addressed to a single member via `ephemeral_message_parameters` that only they can see. This keeps the chat clean (no public "message deleted" warnings) while still notifying the offender privately. The shape matters: Bot API 10.3 replaced the top-level `receiver_user_id` parameter with the `ephemeral_message_parameters` object, and sending the retired form risks the notice being delivered to the whole chat instead of one member. Delivery is best-effort and failures are logged, not fatal.

   > Note: the Telegram Bot API does not deliver an update when a regular user deletes their *own* message in a group, so the notice is tied to the bot's own removals rather than user self-deletions.

6. **Admin `/promote`**: A chat admin (including an anonymous admin) or an admin of one of the `ME` channels sends `/promote @username`, or replies `/promote` to a user's message. The bot shows buttons with ranks (kB / MB / GB / TB) plus "Сбросить"; an admin's click grants that rank out of turn. The user is treated as having at least that rank's message count, so the matching permissions (links, media) unlock too. Overrides are stored in the `level_overrides` collection in the database from `MONGODB_URI`. The bot can't resolve `@username` on its own, so it remembers usernames of people who have posted (`known_users`); for someone it hasn't seen yet, reply to their message.

7. **Admin `/unban`**: The same admins send `/unban @username`, or reply `/unban` to a user's message, to lift a restriction or a ban. A kicked member is unbanned; a restricted one gets the chat's default member permissions back (what regular members of the group can do), via `restrictChatMember` with `use_independent_chat_permissions`.

8. **Admin per-thread rules**: in a comment thread of a channel post (a vacancy, an announcement, a thread where links are the point) the same admins send `/allow_links` or `/allow_media` and the matching gate stops applying to **that thread only** — everyone may post links/media there regardless of their message count. `/disallow_links` and `/disallow_media` put the checks back. The rule is keyed by `message_thread_id`, so it survives restarts (stored in the `thread_rules` collection in the database from `MONGODB_URI`, loaded into memory at startup and checked synchronously per message). Written outside a thread, the command just explains that it belongs in the comments of a post. `allow_links` also lifts the "message with an external link" gate in that thread. Spam, emoji-flood and reaction checks still apply everywhere.

9. **`/rules` and `/help`**: members can read what the bot enforces without having to break a rule first. `/rules` answers in the thread the command came from (so it is visible in a channel post's comments too) and lists the limits — reactions after 5 messages, links after 20 or a channel boost, media after 50, at most 5 custom emojis — plus the quarantine chat, the rank ladder (kB/MB/GB/TB) and a pointer to `/stat`. `/help` explains what the bot does. Both are rendered from the same constants the gates use (`THRESHOLDS`, `EMOJI_LIMIT`, `RANKS`), so the text cannot drift away from what is actually enforced. The command and its answer are removed after a minute. A private chat is the bot's front door: any message there gets the help text — it used to reply with a raw JSON dump of the update — and moderation never runs on a private conversation.

10. **Unlock notices**: when a member's message count crosses a threshold, the bot says so — an ephemeral message only that member sees, listing what just opened up and pointing at `/rules` and `/stat`. Rank tags used to be applied silently, so the level system was invisible unless someone ran `/stat`. Every capability is announced exactly once: the announcement is recorded in the `level_unlocks` collection (database from `MONGODB_URI`), so a restart never repeats it, and a failed delivery is not recorded, so a later message retries.

11. **Reaction gate**: reactions stay locked until a member has 5 messages, which keeps reaction farms out. An early reaction is removed and the member gets a private ephemeral notice naming the rule, their current count and `/rules` — no mute and no mod-log entry, since an early tap is a mistake and there would be no restriction to lift. The reaction is removed every time; the notice repeats at most once an hour per member, so tapping a dozen posts doesn't produce a dozen messages, and a failed delivery doesn't start that hour — the next early reaction tries again. The 🤡 trap is separate and unchanged: it still costs a 24h mute with a mod-log entry.

12. **Account profile gate**: spam that reads like a real comment gets past the message classifier, but the account behind it still gives itself away in its profile. So every account nobody has judged before is checked **once**, by its profile rather than by its words, before the join gate greets it: `getChat(user_id)` returns the bio, the personal channel, Telegram's own reliability rating (`rating.level`, negative means concern) and the profile photo; the avatar is downloaded and read by `gpt-4o-mini` with vision (`detail: "low"` — 3.3k tokens instead of 25.5k) together with the name, username, bio and channel title, and answers a fixed JSON schema. The verdict combines the model's flags with Telegram's signals: a block needs a score of 0.85 **and** two independent signals, so no single trait — a name, a pretty photo, a missing username, a model refusal — can block a live member. Gender is deliberately not a signal; what is measured is selling intimate content, luring people to DMs or outside platforms, stock/AI avatars and a negative Telegram rating. A confident bot is restricted on sight (`restrictChatMember` without an expiry, message quarantined, mod-log entry with the reasons and the usual one-click "Снять ограничения"), a borderline one is left to the join gate's captcha, and a clean one is waved through. Verdicts live in the `account_checks` collection (database from `MONGODB_URI`), so a restart re-judges nobody and an account expires back into re-checking after 30 days instead of being trusted forever; an admin's unban writes a permanent override, otherwise the model would block the member again on the spot. The gate fails open — a profile Telegram won't show, an unavailable model or a check that outlives its 8s budget all mean "no verdict", never "block" — and is skipped for the family, bots, boosted members and established ones (5+ messages).
