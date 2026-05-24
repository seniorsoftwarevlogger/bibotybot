export function isStatCommand(ctx: { message?: { text?: string } }): boolean {
  const text = ctx.message?.text ?? "";
  return (
    /^\/stat(?:@\w+)?(?:\s|$)/.test(text) ||
    /^@bibotybot\/stat(?:\s|$)/i.test(text)
  );
}

export function boostCacheKey(channelId: number | string, userId: number | string): string {
  return `${channelId}:${userId}`;
}

export function isTelegramServiceUser(user: { first_name?: string }): boolean {
  return user.first_name === "Telegram";
}

export function isMe(
  ctx: {
    message?: {
      from?: { first_name?: string };
      sender_chat?: { username?: string };
    };
  },
  myChannels: string[]
): boolean {
  if (!ctx.message || !ctx.message.from) return false;
  return (
    isTelegramServiceUser(ctx.message.from) ||
    (ctx.message.from.first_name === "Channel" &&
      myChannels.includes(ctx.message.sender_chat?.username ?? ""))
  );
}

export function isChannelBot(ctx: {
  message?: { from?: { first_name?: string } };
}): boolean {
  if (!ctx.message || !ctx.message.from) return false;
  return ctx.message.from.first_name === "Channel";
}

export function hasLinks(ctx: {
  message?: { entities?: Array<{ type: string }> };
}): boolean {
  if (!ctx.message) return false;
  return (
    ctx.message.entities?.some(
      (entity) => entity.type === "url" || entity.type === "text_link"
    ) ?? false
  );
}

export function isOwnChannelExternalReply(
  ctx: {
    message?: {
      external_reply?: {
        origin?: { chat?: { id?: number; username?: string } };
        chat?: { id?: number; username?: string };
      };
      reply_to_message?: {
        chat?: { id?: number };
        sender_chat?: { id?: number };
      };
      chat?: { id?: number };
    };
  },
  myChannels: string[]
): boolean {
  const externalReply = ctx.message?.external_reply;
  const originChat =
    externalReply?.origin && "chat" in externalReply.origin
      ? externalReply.origin.chat
      : null;
  const replyChat = externalReply?.chat;

  if (!originChat?.id || !replyChat?.id || originChat.id !== replyChat.id) {
    return false;
  }

  const replyToMessage = ctx.message?.reply_to_message;
  if (replyToMessage?.chat?.id !== ctx.message?.chat?.id) return false;

  const repliedChannelId = replyToMessage?.sender_chat?.id;
  if (repliedChannelId !== replyChat.id) return false;

  return [originChat.username, replyChat.username].some(
    (username) => username && myChannels.includes(username)
  );
}
