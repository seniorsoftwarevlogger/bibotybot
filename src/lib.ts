export function blockUser(telegram, chatId, userId) {
  return telegram.restrictChatMember(chatId, userId, {
    permissions: {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
    },
  });
}

export function muteFor24h(telegram, chatId, userId) {
  const untilDate = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  return telegram.restrictChatMember(chatId, userId, {
    until_date: untilDate,
    permissions: {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
    },
  });
}

// Bot API methods added in 9.x — deleteMessageReaction (and deleteAllMessageReactions)
// aren't wrapped by Telegraf 4.16.3 yet, so we hit them through the raw callApi
// escape hatch. Requires the bot to have the 'can_delete_messages' admin right.
export function deleteUserReaction(telegram, chatId, messageId, userId) {
  return (telegram as any).callApi("deleteMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    user_id: userId,
  });
}

export function restoreUserRights(telegram, chatId, userId) {
  telegram.restrictChatMember(chatId, userId, {
    permissions: {
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
    },
  });
}

// Ephemeral messages (Bot API 10.2): a group/supergroup message that is visible
// only to the single member named by `receiver_user_id` — nobody else in the chat
// sees it. We use them to privately tell a user why their message was removed,
// instead of announcing the deletion to everyone with a public (then auto-deleted)
// warning. Telegraf 4.16.3 has no typed support for `receiver_user_id` yet, but it
// forwards unknown fields from the extra options object straight to the Bot API,
// so we pass it through there. Delivery is best-effort — Telegram may skip it when
// the recipient is offline — so callers treat a rejection as non-fatal.
export function sendEphemeralMessage(
  telegram,
  chatId,
  userId,
  text,
  extra: Record<string, unknown> = {}
) {
  return telegram.sendMessage(chatId, text, {
    receiver_user_id: userId,
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

export function deleteMediaMessage(ctx, { mute = true, warning }: { mute?: boolean; warning?: string } = {}) {
  const warningText =
    warning ??
    `Медиа за буст канала https://t.me/boost/seniorsoftwarevlogger или за доллар https://boosty.to/seniorsoftwarevlogger`;

  const userId = ctx.message.from?.id;

  return ctx
    .deleteMessage(ctx.message.message_id)
    .then(() =>
      userId
        ? sendEphemeralMessage(
            ctx.telegram,
            ctx.chat.id,
            userId,
            warningText
          ).catch((e) => console.log("CANT SEND EPHEMERAL:", userId, e))
        : undefined
    )
    .then(() =>
      mute
        ? muteFor24h(ctx.telegram, ctx.chat.id, ctx.message.from.id)
        : undefined
    )
    .catch((e) => console.log("CANT DELETE:", ctx.message, e))
    .finally(() => console.log("DELETED", ctx.message.message_id));
}
export function deleteMessage(ctx, warningMessage, { mute = true }: { mute?: boolean } = {}) {
  const userId = ctx.message.from?.id;

  return ctx.telegram
    .copyMessage(`@ssv_purge`, ctx.chat.id, ctx.message.message_id, {
      disable_notification: true,
    })
    .then(() =>
      ctx
        .deleteMessage(ctx.message.message_id)
        .then(() =>
          warningMessage && userId
            ? sendEphemeralMessage(
                ctx.telegram,
                ctx.chat.id,
                userId,
                warningMessage
              ).catch((e) => console.log("CANT SEND EPHEMERAL:", userId, e))
            : undefined
        )
        .then(() =>
          mute ? blockUser(ctx.telegram, ctx.chat.id, ctx.message.from.id) : undefined
        )
        .catch((e) => console.log("CANT DELETE:", ctx.message, e))
        .finally(() => console.log("DELETED", ctx.message.message_id))
    );
}
export function getReplyToChannelId(replyToMessage) {
  return replyToMessage?.sender_chat &&
    replyToMessage?.from.first_name === "Telegram"
    ? replyToMessage.message_id
    : null;
}
