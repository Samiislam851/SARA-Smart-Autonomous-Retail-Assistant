import { z } from "zod";
import { objectIdSchema } from "./common";

export const userRoleSchema = z.enum(["customer", "admin"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const userSchema = z.object({
  _id: objectIdSchema,
  name: z.string().min(1).max(200),
  email: z.email(),
  role: userRoleSchema,
});
export type User = z.infer<typeof userSchema>;

/** Shape for creating a user — `_id` is assigned by MongoDB. */
export const userInputSchema = userSchema.omit({ _id: true });
export type UserInput = z.infer<typeof userInputSchema>;
