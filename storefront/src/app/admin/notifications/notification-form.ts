/**
 * Types shared between `actions.ts` (a `"use server"` file — may only
 * export async functions) and `src/components/admin/NotificationComposer.tsx`.
 */

export interface NotificationFormValues {
  title: string;
  body: string;
  userIds: string[];
}

export interface NotificationFormState {
  errors: Record<string, string>;
  values: NotificationFormValues;
  /** Set on a successful send — how many recipients got a notification. */
  sentCount?: number;
}

export const EMPTY_NOTIFICATION_FORM_VALUES: NotificationFormValues = {
  title: "",
  body: "",
  userIds: [],
};
