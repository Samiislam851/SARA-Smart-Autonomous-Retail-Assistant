import type { Document, WithId } from "mongodb";
import { userSchema, type User } from "@/lib/schemas";
import { getReadyDb, tryToObjectId } from "./shared";

/**
 * Users have no `Date` fields, so the DTO is exactly the validated schema
 * type. Mock login only — see BUILD-DECISIONS.md §5: no passwords, no
 * credential fields, ever. These are read-only lookups against the seeded
 * `users` collection; nothing here writes a user.
 */
export type UserDTO = User;

function mapUserDoc(doc: WithId<Document>): UserDTO {
  const { _id, ...rest } = doc;
  return userSchema.parse({ _id: _id.toString(), ...rest });
}

/** The full mock-login picker list. Sorted by name for a stable, readable list. */
export async function listMockUsers(): Promise<UserDTO[]> {
  const db = await getReadyDb();
  const docs = await db.collection("users").find({}).sort({ name: 1, _id: 1 }).toArray();
  return docs.map(mapUserDoc);
}

export async function getUserById(id: string): Promise<UserDTO | null> {
  const objectId = tryToObjectId(id);
  if (!objectId) return null;
  const db = await getReadyDb();
  const doc = await db.collection("users").findOne({ _id: objectId });
  return doc ? mapUserDoc(doc) : null;
}

export async function getUserByEmail(email: string): Promise<UserDTO | null> {
  const db = await getReadyDb();
  const doc = await db.collection("users").findOne({ email });
  return doc ? mapUserDoc(doc) : null;
}
