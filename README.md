# Cut the BS on Telegram

Simple bot that deletes t.me links from the channel posts.

### Start the bot

```
NODE_ENV=production BOT_TOKEN= PORT= node index.js
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
```

### Spam classifier (Jev shadow mode)

The production spam decision is still made by the OpenAI classifier
(`src/openaiClassifier.ts`). In parallel every checked message is also sent to
TypeSafe's Jev model (`src/jevClassifier.ts`); the verdicts are only compared
and logged — as a `jev_shadow` JSON line in stdout and as a document in the
`bibotybot.jev_shadow` collection.

```
TYPESAFE_API_KEY=       # without it shadow mode is silently disabled
JEV_MODEL=jev-latest
JEV_SPAM_THRESHOLD=0.5  # noul >= threshold means spam
JEV_TIMEOUT_MS=5000
```

Check a single message manually:

```
npm run jev -- "текст сообщения"
```

## Features

1. **Ban Replication**: The bot now supports replicating ban events across all managed channels upon receiving a ban command from an admin.

2. **Thread-specific Link Control**: Admins can allow or block links in specific threads.

3. **Ephemeral removal notices**: When the bot removes a user's message (spam, links, media, etc.), it tells that user *why* using a Telegram [ephemeral message](https://core.telegram.org/bots/features#ephemeral-messages) — a group message addressed to a single member via `receiver_user_id` that only they can see. This keeps the chat clean (no public "message deleted" warnings) while still notifying the offender privately. Requires a Bot API server that supports ephemeral messages (Bot API 10.2+); delivery is best-effort and failures are logged, not fatal.

   > Note: the Telegram Bot API does not deliver an update when a regular user deletes their *own* message in a group, so the notice is tied to the bot's own removals rather than user self-deletions.

### Ban Replication Feature

This new feature allows admins to issue a ban command that will be replicated across all channels managed by the bot. The ban propagates through the channels automatically.

#### How to Issue a Ban Command

Admins can issue a ban command in the following format:

```
/ban <user_id>
```

Where `<user_id>` is the unique identifier of the user to be banned. The bot will confirm once the user has been banned from all managed channels.

### Thread-specific Link Control

Admins can control whether links are allowed in specific threads by using commands.

#### How to Allow Links in a Thread

1. Reply to any message in the thread where you want to allow links
2. Send the command: `/allowLinks`
3. The bot will confirm that links are now allowed in that thread

#### How to Block Links in a Thread

1. Reply to any message in the thread where you want to block links
2. Send the command: `/blockLinks`
3. The bot will confirm that links are now blocked in that thread

**Note**: Only administrators can use these commands. The settings persist across bot restarts and are stored in the database.
