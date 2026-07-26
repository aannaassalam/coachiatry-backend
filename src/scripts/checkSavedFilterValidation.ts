// Self-check for the saved-filter payload guard: `npx ts-node --transpile-only
// src/scripts/checkSavedFilterValidation.ts`. The point of the schema is that a
// client can't smuggle `user` (ownership) through the generic create/update
// factory, so that case is the one that must keep failing.
import assert from "assert";
import { validateSavedFilter } from "../utils/validator";

const run = (body: any) => {
    let err: any = null;
    validateSavedFilter({ body } as any, {} as any, (e?: any) => (err = e));
    return err;
};

const valid = [
    { selectedKey: "status", selectedOperator: "is", selectedValue: "abc" },
];

assert.strictEqual(run({ name: "My filter", filters: valid }), undefined);
assert.strictEqual(
    run({
        name: "No value needed",
        filters: [{ selectedKey: "dueDate", selectedOperator: "isSet", selectedValue: "" }],
    }),
    undefined,
);

assert.ok(run({ name: "Owner hijack", filters: valid, user: "someone-else" }));
assert.ok(run({ name: "", filters: valid }));
assert.ok(run({ name: "No rows", filters: [] }));
assert.ok(run({ filters: valid }));
assert.ok(run({ name: "Bad row", filters: [{ selectedKey: "status" }] }));

console.log("saved filter validation: ok");
