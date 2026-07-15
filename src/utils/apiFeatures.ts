import crypto from "crypto";
import { Query, FilterQuery } from "mongoose";
import { cached, cacheKeys } from "./cache";

interface QueryString {
    [key: string]: string;
}

// Upper bound on page size. `?limit=999999` used to be honored verbatim, which
// let a single request pull an entire collection into memory — and there is no
// authenticated rate limiter in front of it.
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

// Counts change only on insert/delete, never on update, so they tolerate a
// short TTL far better than the rows they accompany.
const COUNT_TTL_SEC = 30;

/**
 * Serialize a Mongo filter to a stable cache key.
 *
 * Not JSON.stringify: key order varies between equivalent filters, and — the
 * dangerous part — JSON.stringify(/foo/i) is "{}", so every regex search would
 * collapse to the same key and serve another search's count. RegExp, Date and
 * ObjectId are all rendered explicitly here for that reason.
 */
function stableStringify(value: any): string {
    if (value === null || value === undefined) return String(value);
    if (value instanceof RegExp) return `RegExp(${value.source}|${value.flags})`;
    if (value instanceof Date) return `Date(${value.toISOString()})`;
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (typeof value === "object") {
        // ObjectId (and other BSON types carrying a hex representation).
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

class APIFeatures<T = any> {
    query: Query<T[], T>;
    queryString: QueryString;
    totalCount: number = 0; // To store the total count of documents
    limit: number = 100; // Default limit

    constructor(query: Query<T[], T>, queryString: QueryString) {
        this.query = query;
        this.queryString = queryString as any;
    }

    /**
     * A filtered countDocuments is a full index/collection scan and runs as a
     * second round trip before the page itself — on a large collection it often
     * costs more than the rows it decorates. Cached briefly, keyed on the exact
     * model + filter.
     *
     * Order-dependent, as before: call it after filter()/search() so the
     * accumulated conditions are on the query.
     */
    async calculateTotalCount() {
        const countQuery = { ...this.query.getQuery() };
        const model = this.query.model;
        const fingerprint = crypto
            .createHash("sha256")
            .update(stableStringify(countQuery))
            .digest("hex");

        this.totalCount = await cached(
            cacheKeys.count(model.modelName, fingerprint),
            COUNT_TTL_SEC,
            () => model.countDocuments(countQuery).exec()
        );
        return this;
    }

    private isMongoOperatorObject(obj: any) {
        return (
            typeof obj === "object" &&
            obj !== null &&
            Object.keys(obj).every((key) => key.startsWith("$"))
        );
    }

    private convertTypes = (obj: any): any => {
        if (Array.isArray(obj)) {
            return obj.map(this.convertTypes);
        } else if (obj !== null && typeof obj === "object") {
            return Object.fromEntries(
                Object.entries(obj).map(([k, v]) => [k, this.convertTypes(v)])
            );
        } else if (typeof obj === "string") {
            if (obj.toLowerCase() === "true") return true;
            if (obj.toLowerCase() === "false") return false;
            // Lets clients express null filters (e.g. `dueDate=null` for
            // "no due date", or `dueDate[ne]=null` for "has a due date").
            if (obj.toLowerCase() === "null") return null;
            if (!isNaN(Number(obj)) && obj.trim() !== "") return Number(obj);
            return obj;
        }
        return obj;
    };

    private flattenObject(
        obj: Record<string, any>,
        parentKey = "",
        result: Record<string, any> = {}
    ) {
        for (const key in obj) {
            const value = obj[key];
            const newKey = parentKey ? `${parentKey}.${key}` : key;

            if (
                value &&
                typeof value === "object" &&
                !Array.isArray(value) &&
                !this.isMongoOperatorObject(value)
            ) {
                this.flattenObject(value, newKey, result);
            } else {
                result[newKey] = value;
            }
        }

        return result;
    }

    private isComplexQuery(obj: any): boolean {
        if (typeof obj !== "object" || obj === null) return false;

        // Check if any key in the object starts with '$' (e.g., $or, $not, $and)
        return Object.keys(obj).some((key) => key.startsWith("$"));
    }

    private excludeFieldsAndParseQuery() {
        // Create a copy of the query string and exclude unwanted fields
        const queryObj = { ...this.queryString };
        const excludedFields = [
            "page",
            "sort",
            "limit",
            "fields",
            "search",
            "searchFields",
            "populate",
            "slim",
        ];
        excludedFields.forEach((el) => delete queryObj[el]);

        // Advanced filtering: handle operators like gte, gt, lte, lt
        let queryStr = JSON.stringify(queryObj);
        queryStr = queryStr.replace(
            /\b(gte|gt|lte|lt|in|not|ne|or)\b/g,
            (match) => `$${match}`
        );

        const parsedQuery = JSON.parse(queryStr);

        const converted = this.convertTypes(parsedQuery);

        return this.isComplexQuery(converted)
            ? converted
            : this.flattenObject(converted); // Return the parsed query object
    }

    filter() {
        const filteredQuery = this.excludeFieldsAndParseQuery();
        this.query = this.query.find(filteredQuery);
        return this;
    }
    sort() {
        // 2) Sorting
        if (this.queryString.sort) {
            const sortBy = this.queryString.sort.split(",").join(" ");
            this.query = this.query.sort(sortBy);
        } else {
            this.query = this.query.sort("-createdAt");
        }
        return this;
    }
    populate() {
        if (this.queryString.populate) {
            const populateFields = this.queryString.populate
                .split(",")
                .join(" ");
            console.log(populateFields);
            // @ts-expect-error: type widening from populate()
            this.query = this.query.populate(populateFields);
        }
        return this;
    }
    search() {
        // Check if `search` query exists and if `searchFields` is present
        if (this.queryString.search && this.queryString.searchFields) {
            const searchValue = this.queryString.search as string;

            // Parse the `searchFields` correctly if it's a string that looks like an array (e.g., "[email,name]")
            let searchFields: string[];
            try {
                searchFields = JSON.parse(
                    this.queryString.searchFields as string
                );
            } catch (error) {
                // Fallback in case it's not a valid JSON string (e.g., "email,name")
                searchFields = (this.queryString.searchFields as string).split(
                    ","
                );
            }
            // Create regex for the search term
            const searchRegex = new RegExp(searchValue, "i"); // 'i' makes it case-insensitive

            // Construct $or array based on searchFields dynamically
            const searchCriteria = searchFields.map((field) => {
                return { [field.trim()]: searchRegex } as FilterQuery<T>;
            });
            const filteredQuery = this.excludeFieldsAndParseQuery();

            // Apply the search condition with proper casting to FilterQuery<T>
            this.query = this.query.find({
                $and: [filteredQuery, { $or: searchCriteria }],
            } as FilterQuery<T>);
        }

        return this;
    }
    limitFields() {
        // 3) Field limiting
        if (this.queryString.fields) {
            const fields = this.queryString.fields.split(",").join(" ");
            this.query = this.query.select(fields);
        } else {
            this.query = this.query.select("-__v");
        }
        return this;
    }

    paginate() {
        // 4) Pagination
        const page = Math.max(1, parseInt(this.queryString.page, 10) || 1);
        const requested = parseInt(this.queryString.limit, 10) || DEFAULT_LIMIT;
        // Clamped: an unbounded ?limit let one request pull a whole collection.
        this.limit = Math.min(Math.max(1, requested), MAX_LIMIT);
        const skip = (page - 1) * this.limit;

        this.query = this.query.skip(skip).limit(this.limit);

        return this;
    }
}

export default APIFeatures;
