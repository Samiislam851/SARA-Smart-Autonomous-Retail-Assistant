import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { listNotificationsForUser } from "@/lib/db/repositories";
import { getSession } from "@/lib/session/auth";
import { markAllReadAction, markNotificationReadAction } from "./actions";

export const metadata: Metadata = { title: "Notifications — NextCart" };

/**
 * Feature B: this user's notifications, newest first, unread visually
 * distinct, with mark-as-read / mark-all-read. Computed fresh from the
 * database on this page load — no polling, no socket (BUILD-DECISIONS.md
 * §0). `session.userId` (server-derived) is the only id ever passed to the
 * repository — see `./actions.ts`'s note on why that's the security
 * boundary, not anything in this page's own markup.
 */
export default async function NotificationsPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/notifications");

  const notifications = await listNotificationsForUser(session.userId);
  const unreadCount = notifications.filter((n) => n.readAt === null).length;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Notifications</h1>
        {unreadCount > 0 && (
          <form action={markAllReadAction}>
            <button type="submit" className="text-sm font-medium text-blue-700 hover:underline">
              Mark all read
            </button>
          </form>
        )}
      </div>

      {notifications.length === 0 ? (
        <p className="text-slate-600">You have no notifications yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {notifications.map((notification) => {
            const isUnread = notification.readAt === null;
            return (
              <li
                key={notification._id}
                className={`flex items-start justify-between gap-4 p-4 ${isUnread ? "bg-amber-50" : ""}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {isUnread && (
                      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                    )}
                    <p
                      className={`text-sm ${
                        isUnread ? "font-semibold text-slate-900" : "font-medium text-slate-700"
                      }`}
                    >
                      {isUnread && <span className="sr-only">Unread: </span>}
                      {notification.title}
                    </p>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{notification.body}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    {new Date(notification.createdAt).toLocaleString()}
                  </p>
                </div>
                {isUnread && (
                  <form action={markNotificationReadAction.bind(null, notification._id)} className="shrink-0">
                    <button
                      type="submit"
                      aria-label={`Mark "${notification.title}" as read`}
                      className="text-xs font-medium text-blue-700 hover:underline"
                    >
                      Mark read
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
