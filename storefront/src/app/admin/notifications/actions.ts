"use server";

import { revalidatePath } from "next/cache";
import { createNotifications } from "@/lib/db/repositories";
import { objectIdSchema } from "@/lib/schemas";
import {
  EMPTY_NOTIFICATION_FORM_VALUES,
  type NotificationFormState,
  type NotificationFormValues,
} from "./notification-form";

export type { NotificationFormState, NotificationFormValues };

/**
 * Admin compose-and-send. Recipients are checkboxes over the seeded user
 * list (rendered server-side by the page from `listMockUsers()`), so
 * `userIds` here is "which of the rendered checkboxes were checked" — still
 * validated as well-formed ObjectId strings before `createNotifications`
 * ever sees them (a hand-crafted extra form field can't smuggle in garbage).
 */
export async function sendNotificationAction(
  _prevState: NotificationFormState,
  formData: FormData
): Promise<NotificationFormState> {
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const userIds = formData.getAll("userIds").map(String);

  const values: NotificationFormValues = { title, body, userIds };
  const errors: Record<string, string> = {};

  if (!title) errors.title = "Title is required.";
  if (!body) errors.body = "Body is required.";
  if (userIds.length === 0) errors.userIds = "Select at least one recipient.";

  const validIds = userIds.filter((id) => objectIdSchema.safeParse(id).success);
  if (userIds.length > 0 && validIds.length !== userIds.length) {
    errors.userIds = "One or more selected recipients were invalid.";
  }

  if (Object.keys(errors).length > 0) {
    return { errors, values };
  }

  await createNotifications(validIds, { title, body });

  revalidatePath("/admin/notifications");
  return { errors: {}, values: EMPTY_NOTIFICATION_FORM_VALUES, sentCount: validIds.length };
}
