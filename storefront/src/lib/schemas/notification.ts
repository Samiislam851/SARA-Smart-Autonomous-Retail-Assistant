import { z } from "zod";
import { objectIdSchema } from "./common";

/**
 * Feature B (notifications) — a new collection. Read from the database on
 * page load/navigation only: BUILD-DECISIONS.md §0 forbids WebSockets,
 * Socket.IO, SSE, EventSource, polling loops and any push mechanism. There
 * is no "unread" boolean; `readAt: null` IS unread, `readAt: <Date>` is when
 * it was read — this is what `countUnreadForUser`/`markNotificationRead`
 * key off.
 */
const notificationShape = {
  _id: objectIdSchema,
  userId: objectIdSchema,
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  createdAt: z.date(),
  readAt: z.date().nullable(),
};

export const notificationSchema = z.object(notificationShape);
export type Notification = z.infer<typeof notificationSchema>;

/** Shape for creating one notification — server assigns `_id`/`createdAt`, and `readAt` always starts `null`. */
const {
  _id: _omittedId,
  createdAt: _omittedCreatedAt,
  readAt: _omittedReadAt,
  ...notificationInputShape
} = notificationShape;

export const notificationInputSchema = z.object(notificationInputShape);
export type NotificationInput = z.infer<typeof notificationInputSchema>;
