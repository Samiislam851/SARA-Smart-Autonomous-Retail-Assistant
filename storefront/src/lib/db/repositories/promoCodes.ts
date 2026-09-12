import type { Document, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import {
  promoCodeInputSchema,
  promoCodeSchema,
  type PromoCode,
  type PromoCodeInput,
} from "@/lib/schemas";
import { getReadyDb, isDuplicateKeyError, tryToObjectId } from "./shared";

export type PromoCodeDTO = Omit<PromoCode, "createdAt"> & { createdAt: string };

const COLLECTION = "promoCodes";

function toDTO(promo: PromoCode): PromoCodeDTO {
  const { createdAt, ...rest } = promo;
  return { ...rest, createdAt: createdAt.toISOString() };
}

function mapDoc(doc: WithId<Document>): PromoCodeDTO {
  const { _id, ...rest } = doc;
  const promo = promoCodeSchema.parse({ _id: _id.toString(), ...rest });
  return toDTO(promo);
}

/**
 * Creates a promo code. `code` is normalized to uppercase before validation
 * (the schema only *validates* uppercase, it never transforms case — see
 * `schemas/common.ts`), and `usedCount` always starts at 0 regardless of
 * what the caller passes (the input schema doesn't even accept it — see
 * §11.7's "omit server-assigned fields" convention). Throws a friendly
 * error on a duplicate code rather than a raw Mongo error.
 */
export async function createPromoCode(input: PromoCodeInput): Promise<PromoCodeDTO> {
  const normalized = promoCodeInputSchema.parse({
    ...input,
    code: input.code.toUpperCase(),
  });

  const db = await getReadyDb();
  const _id = new ObjectId();
  const now = new Date();
  const validated = promoCodeSchema.parse({
    _id: _id.toString(),
    ...normalized,
    usedCount: 0,
    createdAt: now,
  });

  try {
    await db.collection(COLLECTION).insertOne({ ...validated, _id });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new Error(`Promo code "${validated.code}" already exists.`);
    }
    throw error;
  }

  return toDTO(validated);
}

/** Every promo code, newest first — the admin list has no pagination requirement in scope. */
export async function listPromoCodes(): Promise<PromoCodeDTO[]> {
  const db = await getReadyDb();
  const docs = await db.collection(COLLECTION).find({}).sort({ createdAt: -1, _id: -1 }).toArray();
  return docs.map(mapDoc);
}

/** Case-insensitive in effect: normalizes to uppercase before the lookup, matching how codes are stored. */
export async function getPromoCodeByCode(code: string): Promise<PromoCodeDTO | null> {
  const db = await getReadyDb();
  const doc = await db.collection(COLLECTION).findOne({ code: code.toUpperCase() });
  return doc ? mapDoc(doc) : null;
}

export async function setPromoCodeActive(id: string, isActive: boolean): Promise<PromoCodeDTO | null> {
  const objectId = tryToObjectId(id);
  if (!objectId) return null;
  const db = await getReadyDb();
  const result = await db
    .collection(COLLECTION)
    .findOneAndUpdate({ _id: objectId }, { $set: { isActive } }, { returnDocument: "after" });
  return result ? mapDoc(result) : null;
}

/**
 * Atomically bumps `usedCount` by 1. Called once, right after an order that
 * carried this code is successfully created (see
 * `src/app/checkout/actions.ts`) — never before, and never speculatively
 * during cart validation, so a code that's merely *applied* to a cart but
 * never checked out never consumes a use.
 */
export async function incrementPromoUse(code: string): Promise<void> {
  const db = await getReadyDb();
  await db.collection(COLLECTION).updateOne({ code: code.toUpperCase() }, { $inc: { usedCount: 1 } });
}
