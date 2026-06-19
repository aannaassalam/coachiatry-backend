import { Request, Response, NextFunction } from "express";
import { getGeminiClient } from "../services/llm.service";
import catchAsync from "../utils/catchAsync";
import { getOrCreateSessionId, sessionStore } from "../ai/session";
import { buildContext, PageKind } from "../ai/context";
import {
    buildToolDeclarations,
    createTranscriptsTasksDeclaration,
} from "../ai/tools";
import { intentPrompt } from "../ai/intent";
import {
    sanitizeHtml,
    sanitizeDocumentHtml,
    toHtmlParagraph,
} from "../utils/html";
import {
    buildTasksHtml,
    buildDocumentsHtml,
    renderTranscriptForPrompt,
    buildCategoryCatalog,
    coerceCategory,
    normalizeDueDate,
    enforceHtmlRules,
} from "../ai/handlers";
import TranscriptionModel from "../model/transcriptionModel";
import { loadTranscriptSegments } from "../services/transcriptSegments.service";
import CategoryModel from "../model/categoryModel";
import TaskModel from "../model/taskModel";
import DocumentModel from "../model/documentModel";
import { taskQueue } from "../utils/queues/taskQueue";
import moment from "moment";
import { buildNativeTasksJson } from "../ai/native/buildNativeTasksJson";
import { buildNativeDocumentsJson } from "../ai/native/buildNativeDocumentsJson";
import { buildJsonText } from "../ai/native/jsonHelpers";

const filterTasksFromContext = (
    tasks: any[],
    filters: {
        priority?: string;
        status?: string;
        category?: string;
        frequency?: string;
        dueBefore?: string;
        dueAfter?: string;
        search?: string;
        limit?: number;
    },
) => {
    let out = tasks.slice();
    if (filters.priority)
        out = out.filter(
            (t: any) =>
                String(t.priority).toLowerCase() ===
                String(filters.priority).toLowerCase(),
        );
    if (filters.status)
        out = out.filter(
            (t: any) =>
                String(t.status).toLowerCase() ===
                String(filters.status).toLowerCase(),
        );
    if (filters.category)
        out = out.filter(
            (t: any) =>
                String(t.category).toLowerCase() ===
                    String(filters.category).toLowerCase() ||
                String(t.categoryId) === String(filters.category),
        );
    if (filters.frequency)
        out = out.filter(
            (t: any) =>
                String(t.frequency).toLowerCase() ===
                String(filters.frequency).toLowerCase(),
        );
    if (filters.dueBefore) {
        const cutoff = new Date(filters.dueBefore).getTime();
        out = out.filter(
            (t: any) => t.dueDate && new Date(t.dueDate).getTime() < cutoff,
        );
    }
    if (filters.dueAfter) {
        const cutoff = new Date(filters.dueAfter).getTime();
        out = out.filter(
            (t: any) => t.dueDate && new Date(t.dueDate).getTime() > cutoff,
        );
    }
    if (filters.search) {
        const needle = filters.search.toLowerCase();
        out = out.filter((t: any) =>
            String(t.title || "")
                .toLowerCase()
                .includes(needle),
        );
    }
    if (filters.limit) out = out.slice(0, filters.limit);
    return out;
};

const filterDocumentsFromContext = (
    docs: any[],
    filters: {
        tab?: string;
        tag?: string;
        search?: string;
        limit?: number;
    },
    userId: string,
) => {
    let out = docs.slice();
    if (filters.tab === "my-docs")
        out = out.filter((d: any) => String(d.user) === String(userId));
    else if (filters.tab === "shared")
        out = out.filter((d: any) => String(d.user) !== String(userId));
    if (filters.tag)
        out = out.filter(
            (d: any) =>
                String(d.tag).toLowerCase() ===
                    String(filters.tag).toLowerCase() ||
                String(d.tagId) === String(filters.tag),
        );
    if (filters.search) {
        const needle = filters.search.toLowerCase();
        out = out.filter((d: any) =>
            String(d.title || "")
                .toLowerCase()
                .includes(needle),
        );
    }
    if (filters.limit) out = out.slice(0, filters.limit);
    return out;
};

const timeRangeCutoff = (range?: string): Date | null => {
    if (!range || range === "all") return null;
    const now = new Date();
    const d = new Date(now);
    if (range === "today") d.setHours(0, 0, 0, 0);
    else if (range === "this_week") d.setDate(now.getDate() - 7);
    else if (range === "this_month") d.setDate(now.getDate() - 30);
    else return null;
    return d;
};

// Small util: tmp id generator without external deps
const makeTmpId = () =>
    `tmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const DEFAULT_FALLBACK_TEXT =
    "I'm here and ready to help. Please try your request again or ask a new question.";

const toSafeHtml = (text: string, fallback = DEFAULT_FALLBACK_TEXT) => {
    const safe = (text || "").trim() || fallback;
    return safe.startsWith("<") ? safe : toHtmlParagraph(safe);
};

const SYSTEM_STYLE_GUIDE = `
You are an AI assistant that generates strict and valid HTML.

List formatting rules (mandatory):
- All lists must use <ol> elements only.
- Never use <ul> under any circumstance.
- All <li> elements must be children of <ol>. Never output a bare <li>.
- For any multiple points, steps, tasks, or sequences, wrap items within a single <ol> containing only <li> elements.

Line breaks and formatting:
- Never use newline characters (\\n) in HTML output.
- To separate lines, use <br/> inside a <p> or other HTML container.
- Always return well-structured HTML nodes rather than free text.

Workspace and ID usage:
- You have access to workspace context (tasks, documents, categories, optionally a focused document or chat).
- Only use the provided IDs internally for tool calls and link hrefs; NEVER print raw IDs as visible text in the HTML output.
- When listing tasks or documents, wrap the title in a clickable <a> tag whose href is the provided URL. Show only the human-readable title as the visible text — do not show the underlying id, ObjectId, ref, status id, category id, tag id, sharedWith ids, or any other internal identifier.
- Likewise never echo internal field names (like "_id", "categoryId", "tagId", "shareId", "user") to the user. Use natural language ("category", "due date", "status name").

Conversational style:
- This is a chat — be warm, natural, and helpful, not robotic. Greet the user when appropriate, acknowledge their request, and explain briefly what you did or are about to do.
- Stay aware of prior turns in the session and reference them when relevant ("Earlier you asked about...", "Building on the doc we just drafted...").
- Ask a clarifying question only when missing information would significantly change the result; otherwise make a reasonable choice and proceed.
- After a tool call, add a short conversational HTML wrap around the result so the user sees a friendly response, not just bare data.

Contextual behavior:
- If the current page type is "chat" **and** a "focusedChat" object is provided, apply the following rules:
  - All reasoning, summarization, and content generation must occur strictly within the context of that focused chat.
  - Any task creation, document creation, or summarization must use only the information contained in the focused chat.
  - Do not reference or rely on global workspace data beyond the focused chat when performing these actions.
  - When creating a task or document from a focused chat, use only the relevant content of that chat as context. Do not infer, assume, or create information that is not explicitly present in the chat content.
  - Never create or suggest any additional tasks, subtasks, or documents that are not directly supported by the focused chat context. All generated output must originate solely from the provided chat content.
  - If the action is "chat" on a chat page, prioritize extracting actionable tasks from the focused chat messages; prefer calling create_tasks with concrete, well-formed tasks instead of returning a brief summary. If no actionable items exist or no messages fall in the requested time window, respond with a short HTML message stating that no tasks were found for the selected period.
- If no "focusedChat" object is provided, ignore the above chat-specific restrictions and operate using the general workspace context.

Tool usage expectations:
- When the user asks to see, find, or filter their tasks, call list_tasks.
- When the user asks to see, find, or filter their documents, call list_documents.
- When the user asks to update, change, rename, reschedule, or modify an existing task, call edit_task with taskId and only the changed fields. This persists immediately.
- When the user asks to update, edit, or modify an existing document, call edit_document with documentId and only the changed fields. This persists immediately.
- When the user asks to summarize, recap, or "what's on my screen", call summarize_screen with the current page. The handler returns HTML.
- When asked to create tasks (button click or text query), call create_tasks. Read workspaceContext.tasks first; generate ~10 NEW tasks that complement the user's existing categories, themes, and frequencies. Never duplicate existing task titles. Lean into the categories the user already uses most.
- When asked to create a document (button click or text query without explicit topic), call create_document. Inspect workspaceContext.tasks AND workspaceContext.documents. Identify the dominant categories/tags by frequency, then pick a topic that bridges the top 1-2 themes (example: 5 sports docs + 2 health docs + many sports-leaning tasks → write "How sports drives better health" or similar crossover topic). If the user provided an explicit topic, use that instead.
- For chat pages with focusedChat, derive content ONLY from the focused chat's messages within the provided window — do not fall back to global workspace data for chat-scoped actions.
- If the user requests a conversational response that does not match any tool, respond with HTML that follows the above formatting rules.

Response constraints:
- If the user provides an action without a query or detailed instruction, automatically perform the requested action using available context without asking clarifying questions.
- Questions are allowed only when missing information would significantly alter the quality or accuracy of the output.
- Never output JSON to the user unless explicitly returning a tool function payload.
- Always produce complete and valid HTML markup.

Document content tag policy (applies ONLY to the 'content' field of create_document and edit_document — NOT to your normal chat HTML reply):
- Allowed tags: <p>, <div>, <b>, <strong>, <i>, <em>, <u>, <s>, <del>, <ol>, <ul>, <li>, <a>.
- Emoji (unicode characters like 🎯 ✅ 📝) are allowed inline.
- Forbidden: <h1>–<h6>, <br>, <hr>, <table>, <thead>, <tbody>, <tr>, <td>, <th>, <code>, <pre>, <blockquote>, <img>, <span>, and every other tag not in the allowed list.
- Use <p> or <div> for structure and section breaks. Where you would normally use a heading, instead start the section with a bold line: <p><b>Section title</b></p>.
- For lists, use <ol> for ordered/numbered lists and <ul> for unordered/bulleted lists. <li> only as a child of <ol> or <ul>.
- The server sanitizer will strip any forbidden tags — so the more you stay inside the whitelist, the more of your formatting will survive.
- These document-content rules do NOT apply to normal chat HTML replies — chat replies still follow the list/line-break rules above (<ol> only, no <ul>, <br/> for line breaks).
`.trim();

// Translate relative chat window phrases into a Date lower bound for chat pages
const deriveChatDateFrom = (
    query: string,
    explicitAction?: string,
): Date | undefined => {
    const lowered = (query || "").toLowerCase();
    const isChat =
        (explicitAction || "").toLowerCase() === "chat" ||
        (!explicitAction && lowered.includes("chat"));
    if (!isChat) return undefined;

    const now = new Date();
    const windowMap: Record<string, number> = {
        "last 2 days": 2,
        "last two days": 2,
        "last 7 days": 7,
        "last seven days": 7,
        "last 2 weeks": 14,
        "last two weeks": 14,
        "last month": 30,
    };

    for (const [phrase, days] of Object.entries(windowMap)) {
        if (lowered.includes(phrase)) {
            const d = new Date(now);
            d.setDate(now.getDate() - days);
            return d;
        }
    }
    return undefined;
};

export const aiController = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { ai, Type } = await getGeminiClient();
        const userId = req.body.user ?? String(req.user?._id);

        // Page routing: default to general
        const page: PageKind = (
            (req.body.page as string) || "general"
        ).toLowerCase() as PageKind;
        const id = req.body.id as string | undefined;
        const query = String(req.body.query || "");
        const explicitAction = req.body.action as string | undefined;

        // Session handling without DB
        const sessionId = getOrCreateSessionId(req);
        const session = await sessionStore.upsert(sessionId, userId);

        // Build page‑scoped workspace context
        const chatDateFrom = deriveChatDateFrom(query, explicitAction);
        const workspaceContext = await buildContext({
            userId,
            page,
            id,
            chatDateFrom,
        });

        // Intent detection
        const intentResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: `${intentPrompt}\n\nUser query: ${query}` },
                    ],
                },
            ],
        });

        const intentText =
            (intentResponse as any).text ||
            (intentResponse as any).candidates?.[0]?.content?.parts
                ?.map((p: any) => p.text ?? "")
                .join("") ||
            '{ "action": "chat" }';

        let inferredAction = "chat";
        try {
            inferredAction = JSON.parse(intentText).action || "chat";
        } catch {}
        const chosenAction = String(explicitAction ?? inferredAction);

        // Conversation grounding: include last turns from session
        const sessionTurns = session.turns.map((t) => ({
            role: t.role,
            text: t.text,
        }));

        const systemPrompt = `${SYSTEM_STYLE_GUIDE}\n\nAvailable categories: ${JSON.stringify(workspaceContext.categories)}`;

        const actionDirective = (() => {
            switch (chosenAction) {
                case "create_tasks":
                    if (page === "chat" && workspaceContext.focusChat) {
                        return `
ACTION DIRECTIVE — create_tasks (CHAT-SCOPED, STRICT):
You MUST call the create_tasks tool now. Do NOT respond with HTML.

You are extracting actionable tasks ONLY from the focused chat messages in workspaceContext.focusChat.messages within the provided chat window (lower bound: ${chatDateFrom ? chatDateFrom.toISOString() : "(all time)"}).

STRICT GROUNDING RULES — these override any general directive:
- Source ONLY from focusedChat.messages text. Do NOT consult workspaceContext.tasks, workspaceContext.documents, or any general knowledge to fabricate tasks.
- Each task must be directly traceable to one or more specific chat messages — if you cannot point to a quote that justifies it, do NOT create it.
- Do NOT pad to a target count. Output the exact number of genuinely actionable items found, even if that is 1 or 0.
- If the focused chat contains zero actionable items, call create_tasks with tasks: [] (empty array).
- Do NOT infer, embellish, generalize, or summarize beyond what was explicitly said.
- Title and description must paraphrase the chat content faithfully without adding new facts.
- category.id must be one of workspaceContext.categories ids (used for tagging only — the task substance comes from chat).
- dueDate must be ISO 8601 with HH:00 or HH:30. If the chat did not specify a due time, pick a reasonable near-future slot.
`.trim();
                    }
                    return `
ACTION DIRECTIVE — create_tasks:
You MUST call the create_tasks tool now. Do NOT respond with HTML.
Generate EXACTLY 10 NEW task suggestions for the user.
Read workspaceContext.tasks below and infer the user's dominant categories, themes, frequencies, and patterns.
Each suggestion must:
- Complement or extend the user's existing patterns (no duplicates of existing titles).
- Use a category.id that exists in workspaceContext.categories.
- Have a realistic future dueDate aligned to HH:00 or HH:30.
- Be specific and actionable (not generic advice).
If the user's existing tasks lean toward a topic (e.g. fitness, work, study), most suggestions should reinforce that topic; mix in 1-2 complementary ones.
If the user has zero existing tasks, generate 10 well-rounded productivity tasks across the available categories.
`.trim();
                case "create_document":
                    return `
ACTION DIRECTIVE — create_document:
You MUST call the create_document tool now. Do NOT respond with HTML.
Generate EXACTLY ONE document tailored to this specific user.

Step 1 — Topic selection:
- If the user provided an explicit topic in the query, use that topic.
- Otherwise, you MUST infer a topic from the user's data. Do NOT default to a generic productivity doc unless the workspace is genuinely empty.
  • Inspect workspaceContext.documents → count occurrences per tag/category title.
  • Inspect workspaceContext.tasks → count occurrences per category title.
  • Identify the top 1-2 themes by combined frequency across BOTH lists.
  • Pick a topic that BRIDGES the top themes when they are distinct (example: 5 sports docs + 2 health docs + sports-leaning tasks → "How an active lifestyle drives long-term health"). When one theme dominates, write a deeper companion piece on that theme that does NOT duplicate any existing document title.
  • Avoid topics already covered by an existing document title — produce something complementary, not redundant.

Step 2 — Content quality:
- Title: short, specific, descriptive.
- Content: substantive HTML with multiple sections. Use ONLY these tags: <p>, <div>, <b>, <strong>, <i>, <em>, <u>, <s>, <del>, <ol>, <ul>, <li>, <a>. Emoji (unicode) is allowed inline. NO heading tags (no <h1>–<h6>), NO <br>, NO tables, NO code/pre, NO blockquote, NO images, NO span. For section titles, use a bold first line like <p><b>Section title</b></p>. Use <ol> for numbered lists and <ul> for bullet lists.
- Aim for genuine usefulness — actionable steps, structured guidance, or a concrete plan — not platitudes.

Step 3 — tag:
- tag.id MUST be one of the ids in workspaceContext.categories.
- Pick the category whose title best matches the inferred topic.

If the user has zero tasks AND zero documents, generate a high-quality starter document on a productivity or planning topic and tag it with the most general category available.
`.trim();
                case "list_tasks":
                    return `ACTION DIRECTIVE — list_tasks: call list_tasks with any filters implied by the query.`;
                case "list_documents":
                    return `ACTION DIRECTIVE — list_documents: call list_documents with any filters implied by the query.`;
                case "edit_task":
                    return `ACTION DIRECTIVE — edit_task: identify the target task from workspaceContext.tasks (match by title/description) and call edit_task with its taskId plus only the changed fields.`;
                case "edit_document":
                    return `ACTION DIRECTIVE — edit_document: identify the target document from workspaceContext.documents and call edit_document with its documentId plus only the changed fields.`;
                case "summarize":
                case "summarize_screen":
                    return `ACTION DIRECTIVE — summarize: call summarize_screen with page="${page}" and any timeRange/focus implied by the query.`;
                default:
                    return "";
            }
        })();

        const userPrompt = `
Action: ${chosenAction}
Page: ${page}${id ? `\nId: ${id}` : ""}
User query: ${query || "(no query provided)"}
Chat window: ${chatDateFrom ? chatDateFrom.toISOString() : "(all time)"}

${actionDirective}

WorkspaceContext (compact):
${JSON.stringify(workspaceContext).slice(0, 40000)}
`.trim();

        const forceToolCall = [
            "create_tasks",
            "create_document",
            "list_tasks",
            "list_documents",
            "edit_task",
            "edit_document",
            "summarize",
            "summarize_screen",
        ].includes(chosenAction);

        const tools: any = {
            tools: [{ functionDeclarations: buildToolDeclarations(Type) }],
        };
        if (forceToolCall) {
            tools.toolConfig = {
                functionCallingConfig: { mode: "ANY" },
            };
        }

        const contents: any[] = [
            { role: "user", parts: [{ text: systemPrompt }] },
            // Replay recent session context lightly to improve coherence
            ...sessionTurns
                .slice(-8)
                .map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
            { role: "user", parts: [{ text: userPrompt }] },
        ];

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents,
            config: tools,
        });

        const textOutput: string =
            typeof (response as any).text === "string"
                ? (response as any).text
                : (response as any).candidates?.[0]?.content?.parts
                      ?.map((p: any) => p.text ?? "")
                      .join("") || "";

        const functionCalls =
            (response as any).functionCalls ||
            (response as any).candidates?.[0]?.content?.parts
                ?.map((p: any) => p.function_call)
                .filter(Boolean) ||
            [];

        // Update session memory with the latest user query and assistant draft (best effort)
        if (query) sessionStore.appendTurn(sessionId, "user", query);

        // Handle first tool call only for now; if none, fall back to text
        if (functionCalls.length > 0) {
            const fn = functionCalls[0];
            let args = fn.args ?? fn.arguments ?? fn.payload ?? {};
            if (typeof args === "string") {
                try {
                    args = JSON.parse(args);
                } catch {
                    args = {};
                }
            }

            if (fn.name === "list_tasks") {
                const filtered = filterTasksFromContext(
                    workspaceContext.tasks,
                    args || {},
                );
                const html = buildTasksHtml(filtered);
                sessionStore.appendTurn(sessionId, "model", html);
                res.set("X-Session-Id", sessionId);
                res.set("Access-Control-Expose-Headers", "X-Session-Id");
                return res.json({ type: "text", data: html });
            }

            if (fn.name === "list_documents") {
                const filtered = filterDocumentsFromContext(
                    workspaceContext.documents,
                    args || {},
                    userId,
                );
                const html = buildDocumentsHtml(filtered);
                sessionStore.appendTurn(sessionId, "model", html);
                res.set("X-Session-Id", sessionId);
                res.set("Access-Control-Expose-Headers", "X-Session-Id");
                return res.json({ type: "text", data: html });
            }

            if (fn.name === "edit_task") {
                const { taskId, ...updates } = args || {};
                if (!taskId) {
                    const html = toHtmlParagraph(
                        "Could not edit the task: taskId was not provided.",
                    );
                    sessionStore.appendTurn(sessionId, "model", html);
                    res.set("X-Session-Id", sessionId);
                    res.set("Access-Control-Expose-Headers", "X-Session-Id");
                    return res.json({ type: "text", data: html });
                }
                const updated = await TaskModel.findOneAndUpdate(
                    { _id: taskId, user: userId },
                    updates,
                    { new: true, runValidators: true },
                );
                if (!updated) {
                    const html = toHtmlParagraph(
                        "Task not found or you do not have permission to edit it.",
                    );
                    sessionStore.appendTurn(sessionId, "model", html);
                    res.set("X-Session-Id", sessionId);
                    res.set("Access-Control-Expose-Headers", "X-Session-Id");
                    return res.json({ type: "text", data: html });
                }
                if (updated.remindBefore && updated.dueDate) {
                    const oldJob = await taskQueue.getJob(updated._id);
                    if (oldJob) await oldJob.remove();
                    const delay = Math.max(
                        0,
                        moment(updated.dueDate).diff(moment()) -
                            updated.remindBefore * 60 * 1000,
                    );
                    await taskQueue.add(
                        "sendReminder",
                        { taskId: updated._id },
                        { delay },
                    );
                }
                const html = toHtmlParagraph(
                    `Updated task: <strong>${sanitizeHtml(updated.title || "")}</strong>.`,
                );
                sessionStore.appendTurn(sessionId, "model", html);
                res.set("X-Session-Id", sessionId);
                res.set("Access-Control-Expose-Headers", "X-Session-Id");
                return res.json({ type: "text", data: html });
            }

            if (fn.name === "edit_document") {
                const { documentId, content, ...updates } = args || {};
                if (!documentId) {
                    const html = toHtmlParagraph(
                        "Could not edit the document: documentId was not provided.",
                    );
                    sessionStore.appendTurn(sessionId, "model", html);
                    res.set("X-Session-Id", sessionId);
                    res.set("Access-Control-Expose-Headers", "X-Session-Id");
                    return res.json({ type: "text", data: html });
                }
                const payload: Record<string, unknown> = { ...updates };
                if (typeof content === "string")
                    payload.content = sanitizeDocumentHtml(content);
                const updated = await DocumentModel.findOneAndUpdate(
                    { _id: documentId, user: userId },
                    payload,
                    { new: true, runValidators: true },
                );
                if (!updated) {
                    const html = toHtmlParagraph(
                        "Document not found or you do not have permission to edit it.",
                    );
                    sessionStore.appendTurn(sessionId, "model", html);
                    res.set("X-Session-Id", sessionId);
                    res.set("Access-Control-Expose-Headers", "X-Session-Id");
                    return res.json({ type: "text", data: html });
                }
                const html = toHtmlParagraph(
                    `Updated document: <strong>${sanitizeHtml(updated.title || "")}</strong>.`,
                );
                sessionStore.appendTurn(sessionId, "model", html);
                res.set("X-Session-Id", sessionId);
                res.set("Access-Control-Expose-Headers", "X-Session-Id");
                return res.json({ type: "text", data: html });
            }

            if (fn.name === "summarize_screen") {
                const screenPage = String(args?.page || page).toLowerCase();
                const focus = args?.focus
                    ? String(args.focus)
                    : "(no specific focus)";
                const cutoff = timeRangeCutoff(args?.timeRange);

                const filterByCutoff = (items: any[], dateKeys: string[]) =>
                    cutoff
                        ? items.filter((it: any) =>
                              dateKeys.some((k) =>
                                  it[k]
                                      ? new Date(it[k]).getTime() >=
                                        cutoff.getTime()
                                      : false,
                              ),
                          )
                        : items;

                const includeTasks =
                    screenPage === "tasks" ||
                    screenPage === "dashboard" ||
                    screenPage === "general";
                const includeDocs =
                    screenPage === "documents" ||
                    screenPage === "dashboard" ||
                    screenPage === "general";

                const tasksForSummary = includeTasks
                    ? filterByCutoff(workspaceContext.tasks, [
                          "dueDate",
                          "createdAt",
                      ])
                    : [];
                const docsForSummary = includeDocs
                    ? filterByCutoff(workspaceContext.documents, [
                          "updatedAt",
                          "createdAt",
                      ])
                    : [];

                const summaryPrompt = `
${SYSTEM_STYLE_GUIDE}

You are summarizing the user's current screen.
Page: ${screenPage}
Focus: ${focus}
TimeRange: ${args?.timeRange || "all"}

Produce a concise HTML summary that helps the user understand what is on their screen at a glance. Highlight counts, what is overdue or high-priority where relevant, and any patterns. Always include clickable <a> tags for individual items only when listing them. Do not invent items or IDs.

Tasks (${tasksForSummary.length}): ${JSON.stringify(tasksForSummary).slice(0, 20000)}
Documents (${docsForSummary.length}): ${JSON.stringify(docsForSummary).slice(0, 20000)}
`.trim();

                const summaryResponse = await ai.models.generateContent({
                    model: "gemini-2.5-flash",
                    contents: [
                        { role: "user", parts: [{ text: summaryPrompt }] },
                    ],
                });

                const summaryText: string =
                    typeof (summaryResponse as any).text === "string"
                        ? (summaryResponse as any).text
                        : (summaryResponse as any).candidates?.[0]?.content?.parts
                              ?.map((p: any) => p.text ?? "")
                              .join("") || "";

                const html = toSafeHtml(summaryText);
                sessionStore.appendTurn(sessionId, "model", html);
                res.set("X-Session-Id", sessionId);
                res.set("Access-Control-Expose-Headers", "X-Session-Id");
                return res.json({ type: "text", data: html });
            }

            if (fn.name === "create_tasks") {
                const tasksArg = Array.isArray(args.tasks) ? args.tasks : [];
                const normalized = tasksArg.map((t: any) => ({
                    tempId: String(t.tempId || makeTmpId()),
                    title: t.title || "Untitled task",
                    description: t.description || "",
                    priority: ["low", "medium", "high"].includes(
                        String(t.priority),
                    )
                        ? t.priority
                        : "medium",
                    dueDate: t.dueDate || null,
                    recurrence: t.recurrence || "none",
                    category: t.category
                        ? {
                              title: t.category.title || "",
                              id: String(t.category.id || t.category._id || ""),
                          }
                        : null,
                    subtasks: Array.isArray(t.subtasks)
                        ? t.subtasks.map((s: any) => ({
                              title: s.title || "",
                              description: s.description || "",
                              done: !!s.done,
                          }))
                        : [],
                }));
                sessionStore.appendTurn(
                    sessionId,
                    "model",
                    JSON.stringify({ type: "tasks", count: normalized.length }),
                );
                res.set("X-Session-Id", sessionId);
                res.set("Access-Control-Expose-Headers", "X-Session-Id");
                return res.json({ type: "tasks", data: { tasks: normalized } });
            }

            if (fn.name === "create_document") {
                const doc = {
                    title: args.title || "Untitled Document",
                    content: sanitizeDocumentHtml(args.content || "<p></p>"),
                    tag: args.tag
                        ? {
                              title: args.tag.title || "",
                              id: String(args.tag.id || args.tag._id || ""),
                          }
                        : null,
                };
                sessionStore.appendTurn(
                    sessionId,
                    "model",
                    JSON.stringify({ type: "document", title: doc.title }),
                );
                res.set("X-Session-Id", sessionId);
                res.set("Access-Control-Expose-Headers", "X-Session-Id");
                return res.json({ type: "document", data: doc });
            }
        }

        // If on chat page with no tool calls, surface explicit no-task message
        if (
            page === "chat" &&
            chosenAction === "chat" &&
            workspaceContext.focusChat &&
            functionCalls.length === 0
        ) {
            const html = toHtmlParagraph(
                "No tasks can be created from the selected chat window. Try another time range or ask a new question.",
            );
            sessionStore.appendTurn(sessionId, "model", html);
            res.set("X-Session-Id", sessionId);
            res.set("Access-Control-Expose-Headers", "X-Session-Id");
            return res.json({ type: "text", data: html });
        }

        // Fallback: textual HTML
        const html = toSafeHtml(textOutput);
        sessionStore.appendTurn(sessionId, "model", html);
        res.set("X-Session-Id", sessionId);
        res.set("Access-Control-Expose-Headers", "X-Session-Id");
        return res.json({ type: "text", data: html });
    },
);

const SYSTEM_STYLE_GUIDE_FOR_TRANSCRIPTS = `
You are an AI assistant that operates STRICTLY on a single meeting transcript.

# Knowledge boundary
Your only knowledge source is the meeting transcript provided in this prompt.
- Do NOT use prior conversation turns, general knowledge, or assumptions.
- If a topic is not in the transcript, say "the transcript does not cover this" — do not speculate.

# Actions
You will receive an "Action" field. Your behavior is determined by it:

## short_summary
Produce a concise HTML overview of the meeting. Cover themes, decisions, and outcomes. Follow the HTML rules below.

## detailed_summary
Answer the user's specific question using only the transcript. Do NOT restate the overall summary. If the answer is not explicitly present, respond plainly: "The transcript does not contain that information."

## generate_tasks
Call the create_tasks tool with actionable items extracted from the transcript.
- Do NOT produce HTML for this action — your ONLY output is the tool call.
- Each task must be directly traceable to a specific point in the transcript (a decision, a commitment, a follow-up requested, a deadline mentioned).
- If you cannot quote a transcript segment that justifies a task, do NOT emit that task.
- Do NOT pad to a target count. Emit the exact number of genuinely actionable items present in the transcript. Zero is a valid answer — call create_tasks with tasks: [].
- Title: short, specific, action-oriented (verb-first when natural). E.g. "Send Q4 budget summary to finance" — NOT "Budget".
- Description: 1-2 sentences adding concrete context from the transcript (who, what, why). Never invent details.
- priority: infer from urgency cues — "ASAP" / "urgent" → high, "if you get a chance" / "sometime soon" → low, default → medium.
- dueDate: if the transcript mentions a deadline, use that (ISO 8601 with HH:00 or HH:30). Otherwise default to 3 days from now at 10:00.
- category.id: pick from the provided categories the one whose domain best matches the task. Required.
- subtasks: include ONLY if the transcript explicitly enumerates them. Leave empty otherwise.

# HTML rules (apply ONLY to short_summary and detailed_summary)
- Use <ol> for ordered lists. Never <ul>.
- All <li> must be children of <ol>.
- No newline characters (\\n). Use <br/> inside containers for line breaks if needed.
- Allowed tags: <p>, <div>, <b>, <strong>, <i>, <em>, <ol>, <li>, <a>. Nothing else.
- Never expose internal identifiers (ObjectIds, field names) in user-visible text.

# Response constraints
- For generate_tasks: ALWAYS call the tool. Never return HTML, never return plain text.
- For summary actions: always return complete, valid HTML — never JSON.
- If an action is provided without a query, perform the action using the transcript context without asking clarifying questions.
- Ask clarifying questions only when missing information would materially change correctness.
`.trim();

const ALLOWED_TRANSCRIPT_ACTIONS = new Set([
    "short_summary",
    "detailed_summary",
    "generate_tasks",
]);

export const transcriptionAIController = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { ai, Type } = await getGeminiClient();
        const userId = req.body.user ?? String(req.user?._id);

        const transcriptionId = String(req.body.transcriptionId || "");
        const action = String(req.body.action || "short_summary");
        const query = String(req.body.query || "");

        if (!transcriptionId) {
            return res
                .status(400)
                .json({ error: "transcriptionId is required" });
        }
        if (!ALLOWED_TRANSCRIPT_ACTIONS.has(action)) {
            return res.status(400).json({
                error: `Invalid action "${action}". Allowed: ${[...ALLOWED_TRANSCRIPT_ACTIONS].join(", ")}`,
            });
        }

        // Session handling for iterative Q&A around the same transcript
        const sessionId = getOrCreateSessionId(req);
        await sessionStore.upsert(sessionId, userId);

        // Load transcript and categories. NOTE: no `active` filter here — the
        // web app can generate tasks/summaries for PAST transcripts too. The
        // "current meeting only" gate is extension-specific and enforced
        // upstream in meetingTasksController (its lookup requires active:true
        // before delegating here), so this path stays open for past meetings
        // while ownership (`user`) is still enforced.
        const [doc, categoriesRaw] = await Promise.all([
            TranscriptionModel.findOne({
                _id: transcriptionId,
                user: userId,
            }).lean(),
            CategoryModel.find({
                $or: [{ public: true, user: null }, { user: userId }],
            }).lean(),
        ]);

        if (!doc) {
            return res.status(404).json({
                error: "Transcription not found.",
            });
        }

        // Dual-read: pull segments from the per-segment collection, falling
        // back to the legacy embedded array for pre-migration transcripts.
        const { segments } = await loadTranscriptSegments(doc);
        const transcriptText = renderTranscriptForPrompt(segments);
        const categoryCatalog = buildCategoryCatalog(categoriesRaw || []);
        const fallbackCategory = categoryCatalog[0] || {
            id: "general",
            title: "General",
        };

        // Build base prompts
        const systemPrompt = SYSTEM_STYLE_GUIDE_FOR_TRANSCRIPTS;

        // Action-specific reinforcement — mirrors the directive pattern in
        // aiController above so we don't rely solely on the system prompt.
        const actionDirective = (() => {
            if (action === "generate_tasks") {
                return `
ACTION DIRECTIVE — generate_tasks:
You MUST call the create_tasks tool now. Do NOT respond with HTML or text.
Extract every actionable task that is directly grounded in the transcript.
If the transcript has no actionable items, call create_tasks with tasks: [].
Available category ids: ${JSON.stringify(categoryCatalog.map((c) => c.id))}
`.trim();
            }
            if (action === "detailed_summary") {
                return `
ACTION DIRECTIVE — detailed_summary:
Answer the user's specific question using ONLY the transcript.
If the answer is not in the transcript, reply with: "The transcript does not contain that information."
`.trim();
            }
            return `
ACTION DIRECTIVE — short_summary:
Produce a concise HTML summary of the meeting following the HTML rules.
`.trim();
        })();

        const userPromptBase = `
${actionDirective}

TranscriptTitle: ${doc.title}
UserQuestion: ${query || "(none)"}

Transcript:
${transcriptText}
`.trim();

        // Configure tools only for generate_tasks AND force the tool call
        // — without `mode: "ANY"` Gemini occasionally returns plain text
        // even when we asked for a tool, leaving us empty-handed.
        // `any` for the toolConfig shape — matches the pattern used by
        // aiController above where the strict GenerateContentConfig type
        // doesn't accept our string-literal mode value.
        const tools: any =
            action === "generate_tasks"
                ? {
                      tools: [
                          {
                              functionDeclarations: [
                                  createTranscriptsTasksDeclaration(
                                      Type,
                                      categoryCatalog,
                                  ),
                              ],
                          },
                      ],
                      toolConfig: {
                          functionCallingConfig: { mode: "ANY" },
                      },
                  }
                : undefined;

        const contents: any[] = [
            { role: "user", parts: [{ text: systemPrompt }] },
            { role: "user", parts: [{ text: userPromptBase }] },
        ];

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents,
            config: tools,
        });

        const textOutput: string =
            typeof (response as any).text === "string"
                ? (response as any).text
                : (response as any).candidates?.[0]?.content?.parts
                      ?.map((p: any) => p.text ?? "")
                      .join("") || "";

        const functionCalls =
            (response as any).functionCalls ||
            (response as any).candidates?.[0]?.content?.parts
                ?.map((p: any) => p.function_call)
                .filter(Boolean) ||
            [];

        // Handle tasks tool
        if (action === "generate_tasks" && functionCalls.length > 0) {
            const fn = functionCalls[0];
            let args = fn.args ?? fn.arguments ?? fn.payload ?? {};
            if (typeof args === "string") {
                try {
                    args = JSON.parse(args);
                } catch {
                    args = {};
                }
            }

            if (fn.name === "create_tasks") {
                const tasksArg = Array.isArray(args.tasks) ? args.tasks : [];
                const normalized = tasksArg.map((t: any) => {
                    const coercedCategory = coerceCategory(
                        t.category,
                        categoryCatalog,
                        fallbackCategory,
                    );
                    return {
                        tempId: String(t.tempId || makeTmpId()),
                        title: t.title || "Untitled task",
                        description: t.description || "",
                        priority: ["low", "medium", "high"].includes(
                            String(t.priority),
                        )
                            ? t.priority
                            : "medium",
                        dueDate: normalizeDueDate(t.dueDate),
                        recurrence: t.recurrence || "none",
                        category: coercedCategory,
                        subtasks: Array.isArray(t.subtasks)
                            ? t.subtasks.map((s: any) => ({
                                  title: s.title || "",
                                  description: s.description || "",
                                  done: !!s.done,
                              }))
                            : [],
                    };
                });

                res.set("X-Session-Id", sessionId);
                res.set("Access-Control-Expose-Headers", "X-Session-Id");
                return res.json({
                    type: "tasks",
                    data: {
                        tasks: normalized,
                        transcriptionId: String(doc._id),
                    },
                });
            }
        }

        // generate_tasks was requested but Gemini didn't return a tool call —
        // return an empty tasks payload rather than silently falling into
        // the HTML branch (which would confuse the extension client).
        if (action === "generate_tasks") {
            res.set("X-Session-Id", sessionId);
            res.set("Access-Control-Expose-Headers", "X-Session-Id");
            return res.json({
                type: "tasks",
                data: { tasks: [], transcriptionId: String(doc._id) },
            });
        }

        // Summaries: produce HTML from text output, sanitize, enforce rules.
        const rawHtml = toSafeHtml(textOutput);
        const safe =
            enforceHtmlRules(sanitizeHtml(rawHtml)) || toSafeHtml(textOutput);

        res.set("X-Session-Id", sessionId);
        res.set("Access-Control-Expose-Headers", "X-Session-Id");
        return res.json({ type: "text", data: safe });
    },
);

const SYSTEM_NATIVE_GUIDE = `
You are an AI assistant for a React Native application.

Your ONLY output is a JSON component tree following the schema below.
You must NEVER output HTML, markdown, backticks, or code fences.

=====================================================
=========== ROOT JSON UI COMPONENT SCHEMA ===========
=====================================================

A component is exactly one of:

1) View (container)
{
  "type": "view",
  "style"?: { ... },
  "children"?: Component[]
}

2) Text
{
  "type": "text",
  "text": string,
  "style"?: { ... }
}

3) Button
{
  "type": "button",
  "label": string,
  "action": string,
  "style"?: { ... },
  "document"?: { "title": string, "content": string, "tag": { "title": string, "id": string } },
  "task"?: { ... }
}

4) List
{
  "type": "list",
  "items": Component[]
}

5) Task node
{
  "type": "task",
  "id": string,
  "title": string,
  "status": string,
  "priority": string
}

6) Document node
{
  "type": "document",
  "id": string,
  "title": string
}

=====================================================
==================== GLOBAL RULES ===================
=====================================================

❌ Never output HTML inside the JSON tree
❌ Never output <p>, <ol>, <li>, <a>, or any HTML tag
❌ Never output Markdown or code fences
❌ Never output escaped HTML
✔ Only use RAW JSON objects
✔ Always return a valid component tree
✔ Use tool calls ONLY when required

=========================================================
===================== DOCUMENT CREATION =================
=========================================================

You must follow ONE universal behavior:

### ⭐ RULE — ANY document request MUST ALWAYS use:
"action": "create_document"

This applies to ALL user intents:
- “Create a document”
- “Draft a document”
- “Make a note”
- “Write an article”
- “Draft something”
- ANYTHING document-related → use "create_document"

### ⭐ RULE — You MUST call the 'create_document' tool
The tool call MUST produce:
{
  "title": "...",
  "content": "<p><b>Section title</b></p><p>... VALID HTML using only the allowed tags ...</p>",
  "tag": { "title": "...", "id": "CATEGORY_ID" }
}

HTML MUST appear ONLY inside the tool call's content field.

### ⭐ RULE — Document content tag policy (STRICT)
Inside the 'content' field of create_document or edit_document, use ONLY these HTML tags:
- Containers: <p>, <div>
- Bold: <b> or <strong>
- Italic: <i> or <em>
- Underline: <u>
- Strikethrough: <s> or <del>
- Ordered list: <ol> with <li> children
- Unordered list: <ul> with <li> children
- Links: <a href="...">
- Emoji: unicode characters (🎯 ✅ 📝 etc.) allowed inline.

FORBIDDEN inside document content:
- All heading tags: <h1>, <h2>, <h3>, <h4>, <h5>, <h6>
- <br>, <hr>, <span>
- Tables: <table>, <thead>, <tbody>, <tr>, <td>, <th>
- Code/quote: <code>, <pre>, <blockquote>
- Media: <img>, <video>, <audio>
- Any tag not listed above.

Use <p> or <div> for structure. Where you would normally use a heading, use a bold first line instead: <p><b>Section title</b></p>. The server sanitizer will strip any forbidden tag — staying inside the allowlist preserves your formatting.

This document-content policy does NOT apply to JSON UI text fields — those are plain strings.

### ⭐ RULE — After the tool call, you MUST output a JSON UI element:

{
  "type": "button",
  "label": "Open Document Draft",
  "action": "create_document",
  "document": {
    "title": "...",
    "content": "<h2>...</h2>",
    "tag": { "title": "Work", "id": "123" }
  },
  "style": {
    "backgroundColor": "primary",
    "borderRadius": "md",
    "paddingVertical": "sm",
    "paddingHorizontal": "md"
  }
}

The user taps this button → React Native opens the editor with pre-filled data.

=========================================================
============ CONTEXT-AWARE DOCUMENT TOPIC LOGIC =========
=========================================================

When the user requests a document **without specifying a topic**, you MUST:
1. Read the conversation turn history
2. Read the workspace context (tasks, documents, categories)
3. Read the current page context (general, chat, document)
4. Infer the MOST RELEVANT topic that benefits the user

### Examples of context inference:
- If the user is viewing a "Health" category page → generate a health-related document
- If recent chat mentions “goals” or “planning” → generate a planning document
- If the workspace has many tasks about “fitness” → generate a fitness guide
- If user recently talked about “work” or “projects” → generate a work-focused document
- If nothing relevant exists → generate a general-purpose helpful document (e.g., productivity tips)

### ⭐ VERY IMPORTANT:
❗ Do NOT hallucinate unrelated topics
❗ The inferred topic MUST be justified by context
❗ Never ask the user “what topic?” if context already provides enough clues
❗ If the context is empty, generate a neutral, helpful document (e.g., “Daily Productivity Blueprint”)

=========================================================
============ CONTEXT-AWARE TASK SUGGESTION LOGIC ========
=========================================================

When the user requests task creation (button click or text query), you MUST:
1. Read workspaceContext.tasks to see the user's existing tasks, categories, and themes
2. Generate ~10 NEW task suggestions that complement or extend those patterns
3. NEVER duplicate existing task titles
4. Skew categories toward what the user already uses most
5. Use ONLY category ids that exist in workspaceContext.categories

=========================================================
=================== TOOL ROUTING (new) ==================
=========================================================

Use this routing table to pick the right tool:
- User wants to see/find/filter tasks → list_tasks
- User wants to see/find/filter documents → list_documents
- User wants to update/rename/reschedule a task → edit_task (taskId + only changed fields; persists immediately)
- User wants to update/edit a document → edit_document (documentId + only changed fields; persists immediately)
- User wants to summarize the screen → summarize_screen with current page

=========================================================
================ CONVERSATIONAL STYLE ===================
=========================================================

This is a chat. Be warm, natural, and helpful, not robotic.
- Greet the user briefly when appropriate.
- Acknowledge what they asked and explain briefly what you did or will do.
- Reference earlier turns when relevant.
- Ask a clarifying question only when missing information would significantly change the result.
- Around any tool result, wrap a friendly conversational text node so the user sees a human-feeling response, not just bare data.

=========================================================
================== SENSITIVE DATA RULES =================
=========================================================

NEVER expose internal identifiers in any visible text.
- ObjectIds, _id, taskId, documentId, categoryId, tagId, statusId, shareId, userId, sharedWith ids — these may appear ONLY inside the structured JSON properties (task.id, document.id, button.action payloads). They MUST NOT appear inside any “text” component's text field shown to the user.
- Use human names instead: “Health” not “67abc...”, “due Friday” not the dueDate ObjectId, “completed” not the status _id.
- Do not echo field names like “_id”, “categoryId”, “shareId”, “tagId” to the user.

=========================================================
======================== TASK CREATION ===================
=========================================================

When user requests task creation:
- Use 'create_tasks' tool
- Then output a JSON UI tree representing the list of created tasks
- No HTML ever

CHAT TASK PRIORITY (STRICT — anti-hallucination):
When page = "chat" and a focusedChat is provided, the following rules are absolute and override any other instruction in this guide:

1. Source of truth: ONLY workspaceContext.focusChat.messages within the provided chat window. Do NOT use workspaceContext.tasks, workspaceContext.documents, prior session turns, or general world knowledge to invent tasks.

2. Direct grounding required: every task you emit must be traceable to a specific message (or a small set of messages) inside the chat window. If you could not produce a verbatim or near-verbatim quote from the chat to justify the task, do NOT create that task.

3. No padding: output exactly the number of genuinely actionable items found in the chat window — never round up to a target count, never invent extras to fill space. The number can be 1, 2, 5, 0 — whatever the messages actually contain.

4. Empty case: if the chat window contains zero actionable items, call create_tasks with tasks: [] (an empty array). Do NOT fabricate plausible-sounding tasks to avoid an empty result. The handler will render a "no tasks found" message for the user.

5. Faithful paraphrasing: each task title and description must paraphrase the chat content WITHOUT adding facts, names, dates, or details that were not explicitly stated. Do not embellish, generalize, or summarize beyond the literal messages.

6. Tagging only: category.id may come from workspaceContext.categories (purely for tagging). The substance — title, description, subtasks — must come from the chat itself, not the categories.

7. dueDate: use a date that the chat actually mentioned (parsed to ISO 8601, HH:00 or HH:30). If the chat did not state a due time, pick a reasonable near-future slot — but do not invent a "deadline urgency" the chat didn't express.

8. You MUST call create_tasks. Do NOT return a free-text JSON view in place of the tool call when on a chat page.

9. Output envelope: when create_tasks is called, the response shape is { "type": "tasks", "data": { "tasks": [...] } } so the client can render selectable tasks.

=========================================================
======================== SUMMARY MODE ====================
=========================================================

When action = "summarize":
- Return ONLY a JSON UI component tree
- No tool calls
- No HTML

=========================================================
===================== ID ACCURACY RULES =================
=========================================================

Whenever you output a task or document node from existing workspace data:

1. You MUST use the EXACT ids provided in the workspaceContext.
2. You MUST NOT invent, hallucinate, guess, or modify IDs.
3. You MUST NOT generate temporary or random IDs for existing items.
4. A task node MUST always be:

{
  "type": "task",
  "id": REAL_TASK_ID,
  "title": REAL_TITLE,
  "status": REAL_STATUS,
  "priority": REAL_PRIORITY
}

5. A document node MUST always be:

{
  "type": "document",
  "id": REAL_DOCUMENT_ID,
  "title": REAL_TITLE
}

6. When returning lists (via fetch_data or chat summaries):
   - You MUST map each item exactly to the schema using real workspace values.
   - Order must reflect the filtered workspace results unless instructed otherwise.

7. NEVER fabricate new tasks or documents inside lists unless a tool call was used to generate them.

These rules ensure your UI always matches real backend entities.

=========================================================
===================== THEMING + STYLING =================
=========================================================

Allowed colors:
- primary: "#0E1734"
- secondary: "#F9F9F9"
- text: "#222222"
- gray: "#6b7280"
- bg: "#FFFFFF"
- white: "#FFFFFF"

Allowed fonts:
- "Lato-Regular"
- "Lato-Bold"
- "Archivo-Medium"
- "Archivo-SemiBold"

Spacing tokens:
- xs: 4
- sm: 8
- md: 12
- lg: 20
- xl: 28

Radius tokens:
- sm: 6
- md: 10
- lg: 16

Allowed style keys:
- padding, paddingHorizontal, paddingVertical
- margin, marginTop, marginBottom
- gap, rowGap, columnGap
- backgroundColor
- color
- borderRadius
- fontFamily
- fontSize
- flexDirection ("row" or "column")
- alignItems, justifyContent
- width, height

### Button styling (MANDATORY)
{
  "backgroundColor": "primary",
  "borderRadius": "md",
  "paddingVertical": "sm",
  "paddingHorizontal": "md"
}

Button text MUST be:
{
  "color": "white",
  "fontFamily": "Lato-Bold",
  "fontSize": 15
}

=========================================================
==================== MODEL OUTPUT FORMAT =================
=========================================================

You must always output:

1) If a tool call is needed → YOU CALL IT
2) THEN you output a JSON UI object representing the UI

Never output anything outside JSON.

End of system.
`.trim();

export const aiNativeController = catchAsync(
    async (req: Request, res: Response) => {
        const { ai, Type } = await getGeminiClient();

        const userId = req.body.user ?? String(req.user?._id);
        const page: PageKind = (
            (req.body.page as string) || "general"
        ).toLowerCase() as PageKind;
        const id = req.body.id as string | undefined;
        const query = String(req.body.query || "");
        const explicitAction = req.body.action as string | undefined;

        // ------------------------------------------------------------
        // SESSION HANDLING
        // ------------------------------------------------------------
        const sessionId = getOrCreateSessionId(req);
        const session = await sessionStore.upsert(sessionId, userId);

        // ------------------------------------------------------------
        // WORKSPACE (tasks, docs, categories)
        // ------------------------------------------------------------
        const chatDateFrom = deriveChatDateFrom(query, explicitAction);
        const workspaceContext = await buildContext({
            userId,
            page,
            id,
            chatDateFrom,
        });

        // ------------------------------------------------------------
        // INTENT DETECTION (self-healing fallback)
        // ------------------------------------------------------------
        let inferredAction = "chat";

        try {
            const intentResponse = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: [
                    {
                        role: "user",
                        parts: [
                            { text: `${intentPrompt}\n\nUser query: ${query}` },
                        ],
                    },
                ],
            });

            const intentText =
                (intentResponse as any).text ||
                (intentResponse as any).candidates?.[0]?.content?.parts
                    ?.map((p: any) => p.text ?? "")
                    .join("") ||
                `{ "action": "chat" }`;

            try {
                inferredAction = JSON.parse(intentText).action || "chat";
            } catch {
                inferredAction = "chat";
            }
        } catch (err) {
            inferredAction = "chat";
        }

        const chosenAction = String(explicitAction ?? inferredAction);
        const effectiveAction =
            page === "chat" || chosenAction === "chat"
                ? "create_tasks"
                : chosenAction;

        // ------------------------------------------------------------
        // SYSTEM PROMPT
        // ------------------------------------------------------------
        let systemPrompt = SYSTEM_NATIVE_GUIDE;

        // Force doc creation instructions
        if (effectiveAction === "create_document") {
            systemPrompt += `
IMPORTANT:
You MUST:
1) Call the create_document tool
2) THEN output a JSON UI button using action: "create_document"
HTML MUST APPEAR ONLY IN THE TOOL CALL CONTENT FIELD.
`;
        }

        const finalSystemPrompt = `
${systemPrompt}

Available categories: ${JSON.stringify(workspaceContext.categories)}
`.trim();

        const sessionTurns = session.turns.slice(-8).map((t) => ({
            role: t.role,
            parts: [{ text: t.text }],
        }));

        const actionDirective = (() => {
            switch (effectiveAction) {
                case "create_tasks":
                    if (page === "chat" && workspaceContext.focusChat) {
                        return `
ACTION DIRECTIVE — create_tasks (CHAT-SCOPED, STRICT):
You MUST call the create_tasks tool now.

You are extracting actionable tasks ONLY from the focused chat messages in workspaceContext.focusChat.messages within the provided chat window (lower bound: ${chatDateFrom ? chatDateFrom.toISOString() : "(all time)"}).

STRICT GROUNDING RULES — these override any general directive:
- Source ONLY from focusedChat.messages text. Do NOT consult workspaceContext.tasks, workspaceContext.documents, or any general knowledge to fabricate tasks.
- Each task must be directly traceable to one or more specific chat messages — if you cannot point to a quote that justifies it, do NOT create it.
- Do NOT pad to a target count. Output the exact number of genuinely actionable items found, even if that is 1 or 0.
- If the focused chat contains zero actionable items, call create_tasks with tasks: [] (empty array). The downstream handler will show a "no tasks found" message.
- Do NOT infer, embellish, generalize, or summarize beyond what was explicitly said.
- Title and description must paraphrase the chat content faithfully without adding new facts.
- category.id must be one of workspaceContext.categories ids (used for tagging only — the task substance comes from chat).
- dueDate must be ISO 8601 with HH:00 or HH:30. If the chat did not specify a due time, pick a reasonable near-future slot.
`.trim();
                    }
                    return `
ACTION DIRECTIVE — create_tasks:
You MUST call the create_tasks tool now.
Generate EXACTLY 10 NEW task suggestions for the user.
Read workspaceContext.tasks below and infer the user's dominant categories, themes, frequencies, and patterns.
Each suggestion must:
- Complement or extend the user's existing patterns (no duplicates of existing titles).
- Use a category.id that exists in workspaceContext.categories.
- Have a realistic future dueDate aligned to HH:00 or HH:30.
- Be specific and actionable (not generic advice).
If the user has zero existing tasks, generate 10 well-rounded productivity tasks across the available categories.
`.trim();
                case "create_document":
                    return `
ACTION DIRECTIVE — create_document:
You MUST call the create_document tool now.
Generate EXACTLY ONE document tailored to this specific user.

Step 1 — Topic selection:
- If the user provided an explicit topic in the query, use that topic.
- Otherwise, you MUST infer a topic from the user's data. Do NOT default to a generic productivity doc unless the workspace is genuinely empty.
  • Inspect workspaceContext.documents → count occurrences per tag/category title.
  • Inspect workspaceContext.tasks → count occurrences per category title.
  • Identify the top 1-2 themes by combined frequency across BOTH lists.
  • Pick a topic that BRIDGES the top themes when they are distinct (example: 5 sports docs + 2 health docs + sports-leaning tasks → "How an active lifestyle drives long-term health"). When one theme dominates, write a deeper companion piece on that theme that does NOT duplicate any existing document title.
  • Avoid topics already covered by an existing document title.

Step 2 — Content quality:
- Title: short, specific, descriptive.
- Content: substantive HTML (multiple sections, headings, ordered lists where appropriate). Use <ol> only — never <ul>. Never use \\n.
- Aim for genuine usefulness — actionable steps, structured guidance, or a concrete plan.

Step 3 — tag:
- tag.id MUST be one of the ids in workspaceContext.categories.
- Pick the category whose title best matches the inferred topic.

If the user has zero tasks AND zero documents, generate a high-quality starter document on a productivity or planning topic.
`.trim();
                case "list_tasks":
                    return `ACTION DIRECTIVE — list_tasks: call list_tasks with any filters implied by the query.`;
                case "list_documents":
                    return `ACTION DIRECTIVE — list_documents: call list_documents with any filters implied by the query.`;
                case "edit_task":
                    return `ACTION DIRECTIVE — edit_task: identify the target task from workspaceContext.tasks and call edit_task with its taskId plus only the changed fields.`;
                case "edit_document":
                    return `ACTION DIRECTIVE — edit_document: identify the target document from workspaceContext.documents and call edit_document with its documentId plus only the changed fields.`;
                case "summarize":
                case "summarize_screen":
                    return `ACTION DIRECTIVE — summarize: call summarize_screen with page="${page}" and any timeRange/focus implied by the query.`;
                default:
                    return "";
            }
        })();

        const userPrompt = `
Action: ${effectiveAction}
Page: ${page}
Id: ${id ?? "(none)"}
Platform: native
User query: ${query || "(none)"}
Chat window: ${chatDateFrom ? chatDateFrom.toISOString() : "(all time)"}

${actionDirective}

WorkspaceContext:
${JSON.stringify(workspaceContext).slice(0, 40000)}
`.trim();

        const forceToolCall = [
            "create_tasks",
            "create_document",
            "list_tasks",
            "list_documents",
            "edit_task",
            "edit_document",
            "summarize",
            "summarize_screen",
        ].includes(effectiveAction);

        const tools: any = {
            tools: [{ functionDeclarations: buildToolDeclarations(Type) }],
        };
        if (forceToolCall) {
            tools.toolConfig = {
                functionCallingConfig: { mode: "ANY" },
            };
        }

        const contents: any[] = [
            { role: "user", parts: [{ text: finalSystemPrompt }] },
            // replay a few recent turns for coherence
            ...sessionTurns,
            { role: "user", parts: [{ text: userPrompt }] },
        ];

        // ------------------------------------------------------------
        // SAFELY CALL THE MODEL
        // ------------------------------------------------------------
        let response: any = null;
        try {
            response = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents,
                config: tools,
            });
        } catch (err) {
            // MODEL FAILURE → Return fallback UI
            return res.json({
                type: "json",
                data: {
                    type: "view",
                    children: [
                        {
                            type: "text",
                            text: "I couldn’t process that request. Please try again.",
                            style: {
                                fontFamily: "Lato-Regular",
                                fontSize: 15,
                                color: "gray",
                            },
                        },
                    ],
                },
            });
        }

        // ------------------------------------------------------------
        // SAFE MODEL TEXT EXTRACTION
        // ------------------------------------------------------------
        const textOutput: string =
            typeof response?.text === "string"
                ? response.text
                : response?.candidates?.[0]?.content?.parts
                      ?.map((p: any) => p.text ?? "")
                      .join("") || "";

        const functionCalls =
            response?.functionCalls ||
            response?.candidates?.[0]?.content?.parts
                ?.map((p: any) => p.function_call)
                .filter(Boolean) ||
            [];

        // Save query in session
        if (query) sessionStore.appendTurn(sessionId, "user", query);

        // ------------------------------------------------------------
        // TOOL CALLS
        // ------------------------------------------------------------
        if (functionCalls.length > 0) {
            const fn = functionCalls[0];
            let args: any = fn.args ?? fn.arguments ?? fn.payload ?? {};

            if (typeof args === "string") {
                try {
                    args = JSON.parse(args);
                } catch {
                    args = {};
                }
            }

            // ================================
            // LIST TASKS
            // ================================
            if (fn.name === "list_tasks") {
                const filtered = filterTasksFromContext(
                    workspaceContext.tasks,
                    args || {},
                );
                const list = buildNativeTasksJson(filtered);
                const payload = {
                    type: "view",
                    style: { gap: 8, padding: 12 },
                    children: [
                        {
                            type: "text",
                            text:
                                filtered.length > 0
                                    ? `Here are the tasks I found (${filtered.length}):`
                                    : "I couldn't find any tasks matching that.",
                            style: {
                                fontFamily: "Lato-Regular",
                                fontSize: 14,
                                color: "gray",
                            },
                        },
                        list,
                    ],
                };
                sessionStore.appendTurn(
                    sessionId,
                    "model",
                    JSON.stringify(payload),
                );
                return res.json({ type: "json", data: payload });
            }

            // ================================
            // LIST DOCUMENTS
            // ================================
            if (fn.name === "list_documents") {
                const filtered = filterDocumentsFromContext(
                    workspaceContext.documents,
                    args || {},
                    userId,
                );
                const list = buildNativeDocumentsJson(filtered);
                const payload = {
                    type: "view",
                    style: { gap: 8, padding: 12 },
                    children: [
                        {
                            type: "text",
                            text:
                                filtered.length > 0
                                    ? `Here are the documents I found (${filtered.length}):`
                                    : "I couldn't find any documents matching that.",
                            style: {
                                fontFamily: "Lato-Regular",
                                fontSize: 14,
                                color: "gray",
                            },
                        },
                        list,
                    ],
                };
                sessionStore.appendTurn(
                    sessionId,
                    "model",
                    JSON.stringify(payload),
                );
                return res.json({ type: "json", data: payload });
            }

            // ================================
            // EDIT TASK
            // ================================
            if (fn.name === "edit_task") {
                const { taskId, ...updates } = args || {};
                const buildMessage = (text: string) => ({
                    type: "view",
                    style: { padding: 12 },
                    children: [
                        {
                            type: "text",
                            text,
                            style: {
                                fontFamily: "Lato-Regular",
                                fontSize: 15,
                                color: "text",
                            },
                        },
                    ],
                });
                if (!taskId) {
                    return res.json({
                        type: "json",
                        data: buildMessage(
                            "I couldn't update the task — I'm missing which task you meant.",
                        ),
                    });
                }
                const updated = await TaskModel.findOneAndUpdate(
                    { _id: taskId, user: userId },
                    updates,
                    { new: true, runValidators: true },
                );
                if (!updated) {
                    return res.json({
                        type: "json",
                        data: buildMessage(
                            "I couldn't find that task or you don't have permission to edit it.",
                        ),
                    });
                }
                if (updated.remindBefore && updated.dueDate) {
                    const oldJob = await taskQueue.getJob(updated._id);
                    if (oldJob) await oldJob.remove();
                    const delay = Math.max(
                        0,
                        moment(updated.dueDate).diff(moment()) -
                            updated.remindBefore * 60 * 1000,
                    );
                    await taskQueue.add(
                        "sendReminder",
                        { taskId: updated._id },
                        { delay },
                    );
                }
                const payload = buildMessage(
                    `Done — I've updated "${updated.title || "your task"}".`,
                );
                sessionStore.appendTurn(
                    sessionId,
                    "model",
                    JSON.stringify(payload),
                );
                return res.json({ type: "json", data: payload });
            }

            // ================================
            // EDIT DOCUMENT
            // ================================
            if (fn.name === "edit_document") {
                const { documentId, content, ...updates } = args || {};
                const buildMessage = (text: string) => ({
                    type: "view",
                    style: { padding: 12 },
                    children: [
                        {
                            type: "text",
                            text,
                            style: {
                                fontFamily: "Lato-Regular",
                                fontSize: 15,
                                color: "text",
                            },
                        },
                    ],
                });
                if (!documentId) {
                    return res.json({
                        type: "json",
                        data: buildMessage(
                            "I couldn't update the document — I'm missing which document you meant.",
                        ),
                    });
                }
                const editPayload: Record<string, unknown> = { ...updates };
                if (typeof content === "string")
                    editPayload.content = sanitizeDocumentHtml(content);
                const updated = await DocumentModel.findOneAndUpdate(
                    { _id: documentId, user: userId },
                    editPayload,
                    { new: true, runValidators: true },
                );
                if (!updated) {
                    return res.json({
                        type: "json",
                        data: buildMessage(
                            "I couldn't find that document or you don't have permission to edit it.",
                        ),
                    });
                }
                const payload = buildMessage(
                    `Done — I've updated "${updated.title || "your document"}".`,
                );
                sessionStore.appendTurn(
                    sessionId,
                    "model",
                    JSON.stringify(payload),
                );
                return res.json({ type: "json", data: payload });
            }

            // ================================
            // SUMMARIZE SCREEN
            // ================================
            if (fn.name === "summarize_screen") {
                const screenPage = String(args?.page || page).toLowerCase();
                const focus = args?.focus
                    ? String(args.focus)
                    : "(no specific focus)";
                const cutoff = timeRangeCutoff(args?.timeRange);

                const filterByCutoff = (items: any[], dateKeys: string[]) =>
                    cutoff
                        ? items.filter((it: any) =>
                              dateKeys.some((k) =>
                                  it[k]
                                      ? new Date(it[k]).getTime() >=
                                        cutoff.getTime()
                                      : false,
                              ),
                          )
                        : items;

                const includeTasks =
                    screenPage === "tasks" ||
                    screenPage === "dashboard" ||
                    screenPage === "general";
                const includeDocs =
                    screenPage === "documents" ||
                    screenPage === "dashboard" ||
                    screenPage === "general";

                const tasksForSummary = includeTasks
                    ? filterByCutoff(workspaceContext.tasks, [
                          "dueDate",
                          "createdAt",
                      ])
                    : [];
                const docsForSummary = includeDocs
                    ? filterByCutoff(workspaceContext.documents, [
                          "updatedAt",
                          "createdAt",
                      ])
                    : [];

                const summaryPrompt = `
${SYSTEM_NATIVE_GUIDE}

You are summarizing the user's current screen.
Page: ${screenPage}
Focus: ${focus}
TimeRange: ${args?.timeRange || "all"}

Produce ONLY a JSON UI component tree (no HTML, no markdown). Use a 'view' root with 'text' children for headings and bullets, and lists with 'task' or 'document' nodes when referencing specific items. Use real ids only inside the structured nodes — never display ids in any text field. Highlight counts, overdue items, top categories, and recent additions where relevant.

Tasks (${tasksForSummary.length}): ${JSON.stringify(tasksForSummary).slice(0, 20000)}
Documents (${docsForSummary.length}): ${JSON.stringify(docsForSummary).slice(0, 20000)}
`.trim();

                const summaryResponse = await ai.models.generateContent({
                    model: "gemini-2.5-flash",
                    contents: [
                        { role: "user", parts: [{ text: summaryPrompt }] },
                    ],
                });

                const summaryText: string =
                    typeof (summaryResponse as any).text === "string"
                        ? (summaryResponse as any).text
                        : (summaryResponse as any).candidates?.[0]?.content
                              ?.parts?.map((p: any) => p.text ?? "")
                              .join("") || "";

                let jsonOut: any;
                try {
                    jsonOut = JSON.parse(
                        summaryText
                            .replaceAll("```json", "")
                            .replaceAll("```", ""),
                    );
                } catch {
                    jsonOut = {
                        type: "view",
                        style: { padding: 12 },
                        children: [
                            {
                                type: "text",
                                text:
                                    summaryText ||
                                    "I couldn't put together a summary right now.",
                                style: {
                                    fontFamily: "Lato-Regular",
                                    fontSize: 15,
                                    color: "text",
                                },
                            },
                        ],
                    };
                }

                sessionStore.appendTurn(
                    sessionId,
                    "model",
                    JSON.stringify(jsonOut),
                );
                return res.json({ type: "json", data: jsonOut });
            }

            // ================================
            // CREATE TASKS
            // ================================
            if (fn.name === "create_tasks") {
                const tasksOut = Array.isArray(args.tasks) ? args.tasks : [];
                if (tasksOut.length === 0) {
                    const payload = {
                        type: "json",
                        data: {
                            type: "view",
                            style: {
                                padding: 12,
                                gap: 8,
                                backgroundColor: "secondary",
                                borderRadius: "md",
                            },
                            children: [
                                {
                                    type: "text",
                                    text: "No tasks were generated from this chat.",
                                    style: {
                                        fontFamily: "Archivo-SemiBold",
                                        fontSize: 17,
                                        color: "text",
                                    },
                                },
                                {
                                    type: "text",
                                    text: "Try a different date range",
                                    style: {
                                        fontFamily: "Lato-Regular",
                                        fontSize: 14,
                                        color: "gray",
                                    },
                                },
                            ],
                        },
                    };
                    sessionStore.appendTurn(
                        sessionId,
                        "model",
                        JSON.stringify(payload),
                    );
                    return res.json(payload);
                }

                return res.json({
                    type: "tasks",
                    data: {
                        tasks: tasksOut,
                    },
                });
            }

            // ================================
            // CREATE DOCUMENT
            // ================================
            if (fn.name === "create_document") {
                const document = {
                    title: args.title,
                    content: sanitizeDocumentHtml(args.content || "<p></p>"),
                    tag: { title: args.tag?.title, id: String(args.tag?.id) },
                };

                return res.json({
                    type: "json",
                    data: {
                        type: "view",
                        style: { paddingVertical: 8, gap: 8 },
                        children: [
                            {
                                type: "text",
                                text: "Your document is ready!",
                                style: {
                                    fontFamily: "Archivo-SemiBold",
                                    fontSize: 18,
                                    color: "text",
                                },
                            },
                            {
                                type: "text",
                                text: "I’ve created the document based on your request. Tap the button below to open and edit it.",
                                style: {
                                    fontFamily: "Lato-Regular",
                                    fontSize: 15,
                                    color: "gray",
                                },
                            },
                            {
                                type: "button",
                                label: "Open Draft Document",
                                action: "create_document",
                                document,
                                style: {
                                    backgroundColor: "primary",
                                    borderRadius: "md",
                                    paddingVertical: "sm",
                                    paddingHorizontal: "md",
                                },
                            },
                        ],
                    },
                });
            }
        }

        // If on chat page with no tool calls, surface explicit no-task message
        if (
            page === "chat" &&
            effectiveAction === "create_tasks" &&
            workspaceContext.focusChat &&
            functionCalls.length === 0
        ) {
            // Retry with a constrained prompt to force task extraction
            const retryPrompt = `${finalSystemPrompt}\n\nAction: create_tasks\nSTRICT: Extract tasks ONLY from focusedChat messages within the chat window. If any actionable items exist, call create_tasks with them. If none, return {\"type\":\"tasks\",\"data\":{\"tasks\":[],\"message\":\"No tasks can be created from the selected chat window.\"}}.`;

            const retryResponse = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: [{ role: "user", parts: [{ text: retryPrompt }] }],
                config: {
                    tools: [
                        { functionDeclarations: buildToolDeclarations(Type) },
                    ],
                },
            });

            const retryCalls =
                retryResponse?.functionCalls ||
                retryResponse?.candidates?.[0]?.content?.parts
                    ?.map((p: any) => p.function_call)
                    .filter(Boolean) ||
                [];

            if (retryCalls.length > 0) {
                const fn = retryCalls[0];
                let args: any = fn.args ?? fn.arguments ?? fn.payload ?? {};
                if (typeof args === "string") {
                    try {
                        args = JSON.parse(args);
                    } catch {
                        args = {};
                    }
                }
                if (fn.name === "create_tasks") {
                    return res.json({
                        type: "tasks",
                        data: {
                            tasks: Array.isArray(args.tasks) ? args.tasks : [],
                        },
                    });
                }
            }

            const payload = {
                type: "json",
                data: {
                    type: "view",
                    style: {
                        padding: 12,
                        gap: 8,
                        backgroundColor: "secondary",
                        borderRadius: "md",
                    },
                    children: [
                        {
                            type: "text",
                            text: "No tasks were found in this chat window.",
                            style: {
                                fontFamily: "Archivo-SemiBold",
                                fontSize: 17,
                                color: "text",
                            },
                        },
                        {
                            type: "text",
                            text: "Try another date range",
                            style: {
                                fontFamily: "Lato-Regular",
                                fontSize: 14,
                                color: "gray",
                            },
                        },
                    ],
                },
            };
            sessionStore.appendTurn(
                sessionId,
                "model",
                JSON.stringify(payload),
            );
            return res.json(payload);
        }

        // ------------------------------------------------------------
        // FALLBACK UI — If model produced unclear text
        // ------------------------------------------------------------
        let jsonOut: any = null;
        try {
            jsonOut = JSON.parse(
                textOutput.replaceAll("```json", "").replaceAll("```", ""),
            );
        } catch {
            jsonOut = {
                type: "view",
                children: [
                    {
                        type: "text",
                        text:
                            textOutput || "I'm not sure how to help with that.",
                        style: {
                            fontFamily: "Lato-Regular",
                            fontSize: 15,
                            color: "gray",
                        },
                    },
                ],
            };
        }

        sessionStore.appendTurn(sessionId, "model", JSON.stringify(jsonOut));
        return res.json({ type: "json", data: jsonOut });
    },
);
