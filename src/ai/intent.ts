import crypto from "crypto";
import { cacheGet, cacheKeys, cacheSet } from "../utils/cache";

export const intentPrompt = `
You are an AI intent detector for a workspace assistant.
Classify the user's message into exactly one of:
- "create_tasks"      — user wants new tasks generated (e.g. "create tasks", "suggest tasks", "give me tasks", "add tasks")
- "create_document"   — user wants a new document drafted. Examples: "create a document", "create document", "draft a document", "draft a note", "make a note", "write something", "write me a doc", "give me a document", "generate a document", "new document", "compose an article". Treat any of these as create_document even when no topic is specified — the assistant will infer the topic from workspace data.
- "list_tasks"        — user wants to see their tasks (e.g. "show my tasks", "what tasks do I have", "list tasks")
- "list_documents"    — user wants to see their documents (e.g. "show my docs", "list documents")
- "edit_task"         — user wants to update an existing task (e.g. "rename task X", "move X to high priority", "reschedule X")
- "edit_document"     — user wants to update an existing document
- "summarize"         — user wants a summary of the screen / their workspace ("summarize", "what's on my screen", "recap")
- "chat"              — anything else, conversational, clarifying questions

Rules:
- "create tasks" or "suggest tasks" with no further context → "create_tasks" (the assistant will use existing-task patterns to suggest).
- "create a document" or "draft something" with no topic → "create_document" (the assistant will infer a topic from workspace data).
- Prefer "chat" only when the request truly does not match any of the above.

Return ONLY raw JSON like { "action": "chat" }. No markdown, no \`\`\` fences, no commentary.
`.trim();

// Valid outputs. Anything else — from the model or from a poisoned cache entry —
// is treated as "chat", which is also the historical fallback.
const VALID_ACTIONS = new Set([
    "create_tasks",
    "create_document",
    "list_tasks",
    "list_documents",
    "edit_task",
    "edit_document",
    "summarize",
    "chat",
]);

// Classification depends only on `intentPrompt` and the user's query — no
// workspace, no session, no user id — so the same question always yields the
// same action. It was the first of two Gemini calls on every /ai and /ai/native
// request, i.e. roughly half the LLM spend on the chat path, re-billed for
// answers already paid for.
//
// The TTL is long because the mapping only changes when the prompt does, and the
// prompt is folded into the key so editing it can't serve verdicts from the old
// one.
const INTENT_TTL_SEC = 60 * 60 * 24 * 7;

// Bounds the key space — a query can be arbitrarily long, a Redis key shouldn't.
const promptFingerprint = crypto
    .createHash("sha256")
    .update(intentPrompt)
    .digest("hex")
    .slice(0, 8);

function intentKey(query: string) {
    const hash = crypto
        .createHash("sha256")
        .update(`${promptFingerprint} ${query}`)
        .digest("hex");
    return cacheKeys.aiIntent(hash);
}

type GenerateContent = (args: {
    model: string;
    contents: unknown;
}) => Promise<unknown>;

/**
 * Classify a user query into an action, reusing a cached verdict for a query
 * we've already classified. Never throws: any failure degrades to "chat", which
 * is what both call sites already fell back to.
 */
export async function classifyIntent(
    generateContent: GenerateContent,
    query: string
): Promise<string> {
    const key = intentKey(query);

    const hit = await cacheGet<string>(key);
    if (hit && VALID_ACTIONS.has(hit)) return hit;

    let action = "chat";
    try {
        const res: any = await generateContent({
            model: "gemini-2.5-flash",
            contents: [
                {
                    role: "user",
                    parts: [{ text: `${intentPrompt}\n\nUser query: ${query}` }],
                },
            ],
        });

        const text =
            res?.text ||
            res?.candidates?.[0]?.content?.parts
                ?.map((p: any) => p.text ?? "")
                .join("") ||
            '{ "action": "chat" }';

        const parsed = JSON.parse(text).action;
        if (typeof parsed === "string" && VALID_ACTIONS.has(parsed)) {
            action = parsed;
        }
    } catch {
        // Model error or unparseable output — same fallback as before, but do
        // NOT cache it: pinning "chat" onto a query for a week because Gemini
        // blipped once would be worse than paying for the retry.
        return "chat";
    }

    await cacheSet(key, action, INTENT_TTL_SEC);
    return action;
}
