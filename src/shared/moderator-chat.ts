/**
 * In-memory storage for moderator chat ID to send notifications.
 *
 * @module shared/moderator-chat
 */

let moderatorChatId: number | null = null;

/**
 * Store the chat ID where moderators want to receive notifications.
 */
export const setModeratorChatId = (chatId: number): void => {
  if (Number.isInteger(chatId)) {
    moderatorChatId = chatId;
  }
};

/**
 * Get the stored moderator chat ID, if any.
 */
export const getModeratorChatId = (): number | null => moderatorChatId;
