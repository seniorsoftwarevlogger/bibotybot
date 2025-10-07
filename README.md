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

## Features

1. **Ban Replication**: The bot now supports replicating ban events across all managed channels upon receiving a ban command from an admin.

2. **Thread-specific Link Control**: Admins can allow or block links in specific threads.

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
