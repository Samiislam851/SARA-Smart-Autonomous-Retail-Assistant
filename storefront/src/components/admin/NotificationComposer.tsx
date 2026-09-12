"use client";

import { useActionState, useEffect, useState } from "react";
import {
  sendNotificationAction,
  type NotificationFormState,
} from "@/app/admin/notifications/actions";
import { EMPTY_NOTIFICATION_FORM_VALUES } from "@/app/admin/notifications/notification-form";
import type { UserDTO } from "@/lib/db/repositories";

const INITIAL_STATE: NotificationFormState = {
  errors: {},
  values: EMPTY_NOTIFICATION_FORM_VALUES,
};

/** `/admin/notifications`'s compose form: title, body, and a checkbox list of the seeded users (plus select-all). */
export function NotificationComposer({ users }: { users: UserDTO[] }) {
  const [state, formAction, isPending] = useActionState(sendNotificationAction, INITIAL_STATE);
  const [selected, setSelected] = useState<Set<string>>(new Set(state.values.userIds));

  // After a successful send, clear the checked recipients (title/body reset
  // via the `key` on <form> below, which remounts the uncontrolled inputs).
  useEffect(() => {
    if (typeof state.sentCount === "number") setSelected(new Set());
  }, [state.sentCount]);

  const allSelected = users.length > 0 && users.every((u) => selected.has(u._id));

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(users.map((u) => u._id)));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <form
      key={state.sentCount ?? "unsent"}
      action={formAction}
      noValidate
      className="flex flex-col gap-4 rounded-md border border-slate-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-slate-900">Compose a notification</h2>

      {typeof state.sentCount === "number" && (
        <p role="status" className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
          Sent to {state.sentCount} recipient{state.sentCount === 1 ? "" : "s"}.
        </p>
      )}

      <div>
        <label htmlFor="title" className="block text-sm font-medium text-slate-700">
          Title
        </label>
        <input
          id="title"
          name="title"
          type="text"
          required
          defaultValue={state.values.title}
          aria-invalid={state.errors.title ? true : undefined}
          aria-describedby={state.errors.title ? "title-error" : undefined}
          className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 ${
            state.errors.title ? "border-red-500" : "border-slate-300"
          }`}
        />
        {state.errors.title && (
          <p id="title-error" role="alert" className="mt-1 text-xs text-red-600">
            {state.errors.title}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="body" className="block text-sm font-medium text-slate-700">
          Body
        </label>
        <textarea
          id="body"
          name="body"
          required
          rows={3}
          defaultValue={state.values.body}
          aria-invalid={state.errors.body ? true : undefined}
          aria-describedby={state.errors.body ? "body-error" : undefined}
          className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 ${
            state.errors.body ? "border-red-500" : "border-slate-300"
          }`}
        />
        {state.errors.body && (
          <p id="body-error" role="alert" className="mt-1 text-xs text-red-600">
            {state.errors.body}
          </p>
        )}
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-slate-700">Recipients</legend>
        <label className="mt-2 flex items-center gap-2 border-b border-slate-200 pb-2 text-sm font-medium text-slate-900">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} />
          Select all ({users.length})
        </label>
        <ul className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto">
          {users.map((user) => (
            <li key={user._id}>
              <label className="flex items-center gap-2 rounded px-1 py-1 text-sm text-slate-700 hover:bg-slate-50">
                <input
                  type="checkbox"
                  name="userIds"
                  value={user._id}
                  checked={selected.has(user._id)}
                  onChange={() => toggleOne(user._id)}
                />
                <span className="truncate">
                  {user.name} <span className="text-slate-400">({user.email})</span>
                </span>
                {user.role === "admin" && (
                  <span className="shrink-0 rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    Admin
                  </span>
                )}
              </label>
            </li>
          ))}
        </ul>
        {state.errors.userIds && (
          <p role="alert" className="mt-1 text-xs text-red-600">
            {state.errors.userIds}
          </p>
        )}
      </fieldset>

      {state.errors.form && (
        <p role="alert" className="text-sm text-red-600">
          {state.errors.form}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-md bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-auto sm:self-end"
      >
        {isPending ? "Sending…" : "Send notification"}
      </button>
    </form>
  );
}
