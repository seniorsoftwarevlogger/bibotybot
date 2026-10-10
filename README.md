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

1. **Join gate**: the gate only arms when someone joins (the `chat_member` update, or the "X joined the group" service message) and fires on the member's **first message**: the message is quarantined, the captcha — a reply in the same thread with the chat rules and a "Я не бот ✅" button — replaces it, and the member is restricted until they press the button. Replying in the same thread keeps the captcha visible in the channel discussion's comment UI, which is the only place a comments-only member ever looks. Further messages are held silently while the captcha is unanswered; a pass restores the chat's default permissions and the captcha turns into a short-lived "Проверка пройдена" note. Nobody is ever kicked: members who never write are never touched, lurkers included. The gate is skipped for established members (5+ messages), the family, bots, and boosted members. The restriction self-expires, so a bot crash can never leave anyone muted forever.

2. **Edited messages are re-checked**: the link, spam, emoji and media gates run on edits too, so posting clean text and editing the links in afterwards no longer bypasses moderation.

3. **Mod log with one-click unban**: every automated restriction (block, 24h mute) is announced to the mod chat (`MOD_CHAT_ID`, defaults to `@ssv_purge`) with the user, chat, reason and a link to the quarantined copy. Notifications about users carry a "Снять ограничения" button — admins of the affected chat press it to lift the restriction; the message is then updated with who did it.

4. **Ban Replication**: when an admin bans a member in one of the managed chats (via the Telegram UI), the ban is automatically replicated to the other managed chats.

5. **Ephemeral removal notices**: When the bot removes a user's message (spam, links, media, etc.), it tells that user *why* using a Telegram [ephemeral message](https://core.telegram.org/bots/features#ephemeral-messages) — a group message addressed to a single member via `receiver_user_id` that only they can see. This keeps the chat clean (no public "message deleted" warnings) while still notifying the offender privately. Requires a Bot API server that supports ephemeral messages (Bot API 10.2+); delivery is best-effort and failures are logged, not fatal.

   > Note: the Telegram Bot API does not deliver an update when a regular user deletes their *own* message in a group, so the notice is tied to the bot's own removals rather than user self-deletions.

6. **Admin `/promote`**: A chat admin (including an anonymous admin) or an admin of one of the `ME` channels sends `/promote @username`, or replies `/promote` to a user's message. The bot shows buttons with ranks (kB / MB / GB / TB) plus "Сбросить"; an admin's click grants that rank out of turn. The user is treated as having at least that rank's message count, so the matching permissions (links, media) unlock too. Overrides are stored in the `level_overrides` collection in the database from `MONGODB_URI`. The bot can't resolve `@username` on its own, so it remembers usernames of people who have posted (`known_users`); for someone it hasn't seen yet, reply to their message.

7. **Admin `/unban`**: The same admins send `/unban @username`, or reply `/unban` to a user's message, to lift a restriction or a ban. A kicked member is unbanned; a restricted one gets the chat's default member permissions back (what regular members of the group can do), via `restrictChatMember` with `use_independent_chat_permissions`.

8. **Admin per-thread rules**: in a comment thread of a channel post (a vacancy, an announcement, a thread where links are the point) the same admins send `/allow_links` or `/allow_media` and the matching gate stops applying to **that thread only** — everyone may post links/media there regardless of their message count. `/disallow_links` and `/disallow_media` put the checks back. The rule is keyed by `message_thread_id`, so it survives restarts (stored in the `thread_rules` collection in the database from `MONGODB_URI`, loaded into memory at startup and checked synchronously per message). Written outside a thread, the command just explains that it belongs in the comments of a post. `allow_links` also lifts the "message with an external link" gate in that thread. Spam, emoji-flood and reaction checks still apply everywhere.
