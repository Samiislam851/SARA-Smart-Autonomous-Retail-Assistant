import type { Document, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import { notificationSchema, objectIdSchema, type Notification } from "@/lib/schemas";
import { getReadyDb, tryToObjectId } from "./shared";

export type NotificationDTO = Omit<Notification, "createdAt" | "readAt"> & {
  createdAt: string;
  readAt: string | null;
};

const COLLECTION = "notifications";

function toDTO(notification: Notification): NotificationDTO {
  const { createdAt, readAt, ...rest } = notification;
  return {
    ...rest,
    createdAt: createdAt.toISOString(),
    readAt: readAt ? readAt.toISOString() : null,
  };
}

function mapDoc(doc: WithId<Document>): NotificationDTO {
  const { _id, ...rest } = doc;
  const notification = notificationSchema.parse({ _id: _id.toString(), ...rest });
  return toDTO(notification);
}

export interface CreateNotificationsContent {
  title: string;
  body: string;
}

/**
 * One document per recipient. `userIds` is validated (each must be a
 * well-formed ObjectId string) before anything is written — a single bad id
 * in the batch fails the whole call rather than silently notifying only
 * some of the intended recipients. Returns `[]` without touching the
 * database for an empty recipient list.
 */
export async function createNotifications(
  userIds: string[],
  content: CreateNotificationsContent
): Promise<NotificationDTO[]> {
  if (userIds.length === 0) return [];

  const title = notificationSchema.shape.title.parse(content.title);
  const body = notificationSchema.shape.body.parse(content.body);
  const validatedUserIds = userIds.map((id) => objectIdSchema.parse(id));

  const db = await getReadyDb();
  const now = new Date();

  const docs = validatedUserIds.map((userId) => {
    const _id = new ObjectId();
    const validated = notificationSchema.parse({
      _id: _id.toString(),
      userId,
      title,
      body,
      createdAt: now,
      readAt: null,
    });
    return { ...validated, _id };
  });

  await db.collection(COLLECTION).insertMany(docs);
  return docs.map((doc) => toDTO({ ...doc, _id: doc._id.toString() }));
}

/** This user's notifications, newest first. Always scoped to a server-derived `userId` — see `src/app/notifications/actions.ts`. */
export async function listNotificationsForUser(userId: string): Promise<NotificationDTO[]> {
  const db = await getReadyDb();
  const docs = await db
    .collection(COLLECTION)
    .find({ userId })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();
  return docs.map(mapDoc);
}

export async function countUnreadForUser(userId: string): Promise<number> {
  const db = await getReadyDb();
  return db.collection(COLLECTION).countDocuments({ userId, readAt: null });
}

/**
 * Marks one notification read. `userId` MUST come from the server session
 * (see `src/lib/session/auth.ts`'s `getSession()`), never from client input
 * — the query filters on `_id` AND `userId` together, so this can never
 * mark (or even find) another user's notification, regardless of what id a
 * caller guesses. Returns `null` for a malformed id, a nonexistent
 * notification, or one that belongs to someone else — the caller cannot
 * distinguish those cases, which is deliberate (no id-enumeration signal).
 */
export async function markNotificationRead(
  id: string,
  userId: string
): Promise<NotificationDTO | null> {
  const objectId = tryToObjectId(id);
  if (!objectId) return null;
  const db = await getReadyDb();
  const result = await db
    .collection(COLLECTION)
    .findOneAndUpdate(
      { _id: objectId, userId },
      { $set: { readAt: new Date() } },
      { returnDocument: "after" }
    );
  return result ? mapDoc(result) : null;
}

/** Marks every unread notification for this (server-derived) user as read. Returns the number updated. */
export async function markAllReadForUser(userId: string): Promise<number> {
  const db = await getReadyDb();
  const result = await db
    .collection(COLLECTION)
    .updateMany({ userId, readAt: null }, { $set: { readAt: new Date() } });
  return result.modifiedCount;
}

/**
 * Admin-only: the most recently sent notifications across every user, for
 * `/admin/notifications`'s "recently sent" list. Not user-scoped — callers
 * must be behind the `/admin/*` gate (`src/middleware.ts`).
 */
export async function listRecentNotifications(limit = 50): Promise<NotificationDTO[]> {
  const db = await getReadyDb();
  const docs = await db
    .collection(COLLECTION)
    .find({})
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .toArray();
  return docs.map(mapDoc);
}
