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

export function deleteMediaMessage(ctx) {
  // block user from sending media
  return ctx
    .deleteMessage(ctx.message.message_id)
    .then(() =>
      ctx.telegram
        .sendMessage(
          ctx.chat.id,
          `Медиа за буст канала https://t.me/boost/seniorsoftwarevlogger или за доллар https://boosty.to/seniorsoftwarevlogger`,
          {
            link_preview_options: { is_disabled: true },
            reply_parameters: {
              message_id: getReplyToChannelId(ctx.message.reply_to_message),
            },
          }
        )
        .then((botReply) =>
          setTimeout(() => ctx.deleteMessage(botReply.message_id), 10000)
        )
    )
    .then(() => blockUser(ctx.telegram, ctx.chat.id, ctx.message.from.id))
    .catch((e) => console.log("CANT DELETE:", ctx.message, e))
    .finally(() => console.log("DELETED", ctx.message.message_id));
}
export function deleteMessage(ctx, warningMessage) {
  // ctx.telegram
  //   .sendMessage(ctx.chat.id, warningMessage, {
  //     link_preview_options: { is_disabled: true },
  //     message_id: getReplyToChannelId(ctx.message.reply_to_message),
  //   })
  //   .then((botReply) => {
  //     setTimeout(() => ctx.deleteMessage(botReply.message_id), 60000);
  //   });

  return ctx.telegram
    .copyMessage(`@ssv_purge`, ctx.chat.id, ctx.message.message_id, {
      disable_notification: true,
    })
    .then((res) =>
      ctx
        .deleteMessage(ctx.message.message_id)
        .then(() => blockUser(ctx.telegram, ctx.chat.id, ctx.message.from.id))
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
