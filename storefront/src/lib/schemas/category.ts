import { z } from "zod";
import { imagePathSchema, objectIdSchema, slugSchema } from "./common";

export const categorySchema = z.object({
  _id: objectIdSchema,
  slug: slugSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  /** Relative web path only — see BUILD-DECISIONS.md §8. */
  imagePath: imagePathSchema,
  sortOrder: z.number().int().min(0).max(1000),
});
export type Category = z.infer<typeof categorySchema>;

/** Shape for creating a category — `_id` is assigned by MongoDB. */
export const categoryInputSchema = categorySchema.omit({ _id: true });
export type CategoryInput = z.infer<typeof categoryInputSchema>;
