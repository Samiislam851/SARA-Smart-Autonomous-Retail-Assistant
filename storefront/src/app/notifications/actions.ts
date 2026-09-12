"use server";

import { revalidatePath } from "next/cache";
import { markAllReadForUser, markNotificationRead } from "@/lib/db/repositories";
import { getSession } from "@/lib/session/auth";

/**
 * Feature B security requirement: `userId` here always comes from the
 * server session (`getSession()`), never from a client-supplied argument —
 * `markNotificationRead`/`markAllReadForUser` both filter on it at the
 * database level, so a signed-in user can never mark (or even discover the
 * existence of) another user's notification by guessing an id. A
 * signed-out caller (no session) is a silent no-op, not an error — mirrors
 * `cart/actions.ts`'s no-cookie no-op convention.
 */
export async function markNotificationReadAction(id: string): Promise<void> {
  const session = await getSession();
  if (!session) return;
  await markNotificationRead(id, session.userId);
  revalidatePath("/notifications");
}

export async function markAllReadAction(): Promise<void> {
  const session = await getSession();
  if (!session) return;
  await markAllReadForUser(session.userId);
  revalidatePath("/notifications");
}
