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
import { sanitizeHtml, toHtmlParagraph } from "../utils/html";
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
import CategoryModel from "../model/categoryModel";
import { buildNativeTasksJson } from "../ai/native/buildNativeTasksJson";
import { buildNativeDocumentsJson } from "../ai/native/buildNativeDocumentsJson";
import { buildJsonText } from "../ai/native/jsonHelpers";

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
- Only use the provided IDs; never invent IDs.
- When listing tasks or documents, include clickable <a> tags pointing to the provided URLs.

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
- When asked to fetch any workspace data, call the fetch_data function.
- When asked to create tasks or documents, call the respective function.
- If the user requests a summary or conversational response, respond with HTML that follows the above formatting rules.

Response constraints:
- If the user provides an action without a query or detailed instruction, automatically perform the requested action using available context without asking clarifying questions.
- Questions are allowed only when missing information would significantly alter the quality or accuracy of the output.
- Never output JSON to the user unless explicitly returning a tool function payload.
- Always produce complete and valid HTML markup.
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

        const userPrompt = `
Action: ${chosenAction}
Page: ${page}${id ? `\nId: ${id}` : ""}
User query: ${query || "(no query provided)"}
Chat window: ${chatDateFrom ? chatDateFrom.toISOString() : "(all time)"}


WorkspaceContext (compact):
${JSON.stringify(workspaceContext).slice(0, 40000)}
`.trim();

        const tools = {
            tools: [{ functionDeclarations: buildToolDeclarations(Type) }],
        };

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

            if (fn.name === "fetch_data") {
                const { type, filters = {} } = args;
                if (type === "tasks") {
                    let filtered = workspaceContext.tasks.slice();
                    if (filters.priority)
                        filtered = filtered.filter(
                            (t: any) =>
                                String(t.priority).toLowerCase() ===
                                String(filters.priority).toLowerCase(),
                        );
                    if (filters.status)
                        filtered = filtered.filter(
                            (t: any) =>
                                String(t.status).toLowerCase() ===
                                String(filters.status).toLowerCase(),
                        );
                    if (filters.tag)
                        filtered = filtered.filter(
                            (t: any) =>
                                String(t.category).toLowerCase() ===
                                    String(filters.tag).toLowerCase() ||
                                String(t.categoryId) === String(filters.tag),
                        );
                    if (filters.date) {
                        const target = new Date(filters.date).toDateString();
                        filtered = filtered.filter(
                            (t: any) =>
                                new Date(t.createdAt).toDateString() ===
                                    target ||
                                (t.dueDate &&
                                    new Date(t.dueDate).toDateString() ===
                                        target),
                        );
                    }
                    if (filters.limit)
                        filtered = filtered.slice(0, filters.limit);
                    const html = buildTasksHtml(filtered);
                    sessionStore.appendTurn(sessionId, "model", html);
                    res.set("X-Session-Id", sessionId);
                    res.set("Access-Control-Expose-Headers", "X-Session-Id");
                    return res.json({ type: "text", data: html });
                }
                if (type === "documents") {
                    let filtered = workspaceContext.documents.slice();
                    if (filters.tag)
                        filtered = filtered.filter(
                            (d: any) =>
                                String(d.tag).toLowerCase() ===
                                    String(filters.tag).toLowerCase() ||
                                String(d.tagId) === String(filters.tag),
                        );
                    if (filters.date) {
                        const target = new Date(filters.date).toDateString();
                        filtered = filtered.filter(
                            (d: any) =>
                                new Date(d.createdAt).toDateString() === target,
                        );
                    }
                    if (filters.limit)
                        filtered = filtered.slice(0, filters.limit);
                    const html = buildDocumentsHtml(filtered);
                    sessionStore.appendTurn(sessionId, "model", html);
                    res.set("X-Session-Id", sessionId);
                    res.set("Access-Control-Expose-Headers", "X-Session-Id");
                    return res.json({ type: "text", data: html });
                }
                const html = toHtmlParagraph(
                    `Unknown fetch type: ${String(type)}`,
                );
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
                    content: sanitizeHtml(args.content || "<p></p>"),
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

Transcript context only:
- Your only knowledge source is the provided meeting transcript. Do not reference any information outside this transcript.
- If asked for details not present in the transcript, state that the information is not available in the transcript.

Action-specific behavior:
- **short_summary**: Produce a concise overall summary of the meeting in valid HTML. Focus on major themes, decisions, and outcomes.
- **detailed_summary**: Respond *only* to the specific user query or question using information from the transcript. Do not restate or include the general summary. If the answer is not explicitly found, respond clearly that the transcript does not contain that information.
- **generate_tasks**: Derive actionable tasks from the transcript and call the create_tasks function with structured results.

Tool usage expectations:
- When asked to generate tasks from the transcript, call the create_tasks function.
- For short_summary or detailed_summary, produce compliant HTML following the above formatting rules.

Response constraints:
- If only an action is provided without a query, automatically perform the action using the transcript context without asking clarifying questions.
- Ask clarifying questions only if missing information would significantly alter correctness.
- Never output JSON to the user unless returning a tool payload.
- Always produce complete and valid HTML markup.
`.trim();

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

        // Session handling for iterative Q&A around the same transcript
        const sessionId = getOrCreateSessionId(req);
        await sessionStore.upsert(sessionId, userId);

        // Load transcript and categories for category inference
        const [doc, categoriesRaw] = await Promise.all([
            TranscriptionModel.findOne({
                _id: transcriptionId,
                user: userId,
                active: true,
            }).lean(),
            CategoryModel.find({
                $or: [{ public: true }, { user: userId }],
            }).lean(),
        ]);

        if (!doc) {
            return res.status(404).json({ error: "Transcription not found" });
        }

        const transcriptText = renderTranscriptForPrompt(doc);
        const categoryCatalog = buildCategoryCatalog(categoriesRaw || []);
        const fallbackCategory = categoryCatalog[0] || {
            id: "general",
            title: "General",
        };

        // Build base prompts
        const systemPrompt = SYSTEM_STYLE_GUIDE_FOR_TRANSCRIPTS;

        const userPromptBase = `
Action: ${action}
TranscriptTitle: ${doc.title}
UserQuestion: ${query || "(none)"}


Transcript:
${transcriptText}
`.trim();

        // Configure tools only for generate_tasks
        const tools =
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
                return res.json({ type: "tasks", data: { tasks: normalized } });
            }
        }

        // For summaries: produce HTML from text output, sanitize and enforce rules
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
  "content": "<h2> ... VALID RAW HTML ... </h2>",
  "tag": { "title": "...", "id": "CATEGORY_ID" }
}

HTML MUST appear ONLY inside the tool call’s content field.

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
======================== TASK CREATION ===================
=========================================================

When user requests task creation:
- Use 'create_tasks' tool
- Then output a JSON UI tree representing the list of created tasks
- No HTML ever

CHAT TASK PRIORITY (important):
- If page = "chat", prioritize generating actionable tasks from the focused chat window.
- For chat actions, prefer calling create_tasks instead of replying with a generic summary.
- If no actionable items exist in the selected chat window, return a short JSON view that tells the user no tasks could be created for that window (do not return a generic summary).
- When create_tasks is used, respond with a top-level object: { "type": "tasks", "data": { "tasks": [...] } } so the client can render selectable tasks.
- When action is "chat":
  * You MUST derive tasks ONLY from the focused chat messages within the provided chat window.
  * Do NOT invent, hallucinate, or import tasks from outside the focused chat.
  * If the focused chat has no actionable items, return a tasks payload with an empty tasks array and a brief message explaining that no tasks could be created for this chat window.
  * You MUST call create_tasks; do not return a free-text JSON view when action is chat on a chat page.

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

        const userPrompt = `
Action: ${effectiveAction}
Page: ${page}
Id: ${id ?? "(none)"}
Platform: native
User query: ${query || "(none)"}
Chat window: ${chatDateFrom ? chatDateFrom.toISOString() : "(all time)"}

WorkspaceContext:
${JSON.stringify(workspaceContext).slice(0, 40000)}
`.trim();

        const tools = {
            tools: [{ functionDeclarations: buildToolDeclarations(Type) }],
        };

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
            // FETCH TASKS
            // ================================
            if (fn.name === "fetch_data") {
                const { type, filters = {} } = args;

                if (type === "tasks") {
                    let filtered = workspaceContext.tasks.slice();

                    if (filters.priority) {
                        filtered = filtered.filter(
                            (t: any) =>
                                String(t.priority).toLowerCase() ===
                                String(filters.priority).toLowerCase(),
                        );
                    }
                    if (filters.status) {
                        filtered = filtered.filter(
                            (t: any) =>
                                String(t.status).toLowerCase() ===
                                String(filters.status).toLowerCase(),
                        );
                    }

                    const json = buildNativeTasksJson(filtered);

                    sessionStore.appendTurn(
                        sessionId,
                        "model",
                        JSON.stringify(json),
                    );
                    return res.json({ type: "json", data: json });
                }

                if (type === "documents") {
                    const docs = workspaceContext.documents.slice();
                    const json = buildNativeDocumentsJson(docs);

                    sessionStore.appendTurn(
                        sessionId,
                        "model",
                        JSON.stringify(json),
                    );
                    return res.json({ type: "json", data: json });
                }
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
                    content: args.content,
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
