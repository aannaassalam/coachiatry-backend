import crypto from "crypto";
import { Model } from "mongoose";

import CategoryModel from "../model/categoryModel";
import StatusModel from "../model/statusModel";
import { cached, cacheDelPattern, cacheKeys } from "./cache";

// Categories and statuses are small, near-immutable lookup tables that back
// dropdowns and board columns, so they get read on the hot path — including on
// every AI request — while changing only when someone edits a category.
//
// TTL plus a namespace flush on any write (see registerReferenceInvalidation).
// The whole namespace goes because these are tiny and the write is rare: it is
// cheaper to recompute a handful of entries than to reason about which filters
// a given edit could have affected.
const REFERENCE_TTL_SEC = 300;

function filterHash(filter: unknown) {
    return crypto
        .createHash("sha256")
        .update(stableStringify(filter))
        .digest("hex");
}

/** See apiFeatures.stableStringify — same reasoning about RegExp/ObjectId. */
function stableStringify(value: any): string {
    if (value === null || value === undefined) return String(value);
    if (value instanceof RegExp) return `RegExp(${value.source}|${value.flags})`;
    if (value instanceof Date) return `Date(${value.toISOString()})`;
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (typeof value === "object") {
        if (typeof value.toHexString === "function") {
            return `OID(${value.toHexString()})`;
        }
        const keys = Object.keys(value).sort();
        return `{${keys
            .map((k) => `${k}:${stableStringify(value[k])}`)
            .join(",")}}`;
    }
    return typeof value === "string" ? JSON.stringify(value) : String(value);
}

async function findCached<T>(
    model: Model<any>,
    namespace: string,
    filter: Record<string, unknown>
): Promise<T[]> {
    return cached(
        cacheKeys.reference(namespace, filterHash(filter)),
        REFERENCE_TTL_SEC,
        () => model.find(filter).lean() as Promise<T[]>
    );
}

export function findCategoriesCached<T = any>(filter: Record<string, unknown>) {
    return findCached<T>(CategoryModel, "categories", filter);
}

export function findStatusesCached<T = any>(filter: Record<string, unknown>) {
    return findCached<T>(StatusModel, "statuses", filter);
}

/**
 * Wired up from the models themselves so a write added later can't forget to
 * invalidate. Registered here rather than in each model file to keep the
 * namespace strings next to the readers that use them.
 */
export function registerReferenceInvalidation() {
    attach(CategoryModel, "categories");
    attach(StatusModel, "statuses");
}

function attach(model: Model<any>, namespace: string) {
    const flush = () => void cacheDelPattern(`ref:${namespace}:*`);
    const schema = model.schema;
    schema.post("save", flush as never);
    schema.post("findOneAndUpdate", flush as never);
    schema.post("findOneAndDelete", flush as never);
    schema.post("updateOne", flush as never);
    schema.post("updateMany", flush as never);
    schema.post("deleteOne", flush as never);
    schema.post("deleteMany", flush as never);
    schema.post("insertMany", flush as never);
}
