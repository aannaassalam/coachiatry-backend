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
        const workspaceContext = await buildContext({ userId, page, id });

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


WorkspaceContext (compact):
${JSON.stringify(workspaceContext).slice(0, 40000)}
`.trim();

        const tools =
            chosenAction === "summarize" || chosenAction === "chat"
                ? undefined
                : {
                      tools: [
                          { functionDeclarations: buildToolDeclarations(Type) },
                      ],
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

        // Early return for chat/summarize without tool calls
        if (
            (chosenAction === "summarize" || chosenAction === "chat") &&
            functionCalls.length === 0
        ) {
            const html =
                textOutput && textOutput.trim().startsWith("<")
                    ? textOutput
                    : toHtmlParagraph(textOutput);
            sessionStore.appendTurn(sessionId, "model", html);
            res.set("X-Session-Id", sessionId);
            res.set("Access-Control-Expose-Headers", "X-Session-Id");
            return res.json({ type: "text", data: html });
        }

        // Handle first tool call only for now
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
                                String(filters.priority).toLowerCase()
                        );
                    if (filters.status)
                        filtered = filtered.filter(
                            (t: any) =>
                                String(t.status).toLowerCase() ===
                                String(filters.status).toLowerCase()
                        );
                    if (filters.tag)
                        filtered = filtered.filter(
                            (t: any) =>
                                String(t.category).toLowerCase() ===
                                    String(filters.tag).toLowerCase() ||
                                String(t.categoryId) === String(filters.tag)
                        );
                    if (filters.date) {
                        const target = new Date(filters.date).toDateString();
                        filtered = filtered.filter(
                            (t: any) =>
                                new Date(t.createdAt).toDateString() ===
                                    target ||
                                (t.dueDate &&
                                    new Date(t.dueDate).toDateString() ===
                                        target)
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
                                String(d.tagId) === String(filters.tag)
                        );
                    if (filters.date) {
                        const target = new Date(filters.date).toDateString();
                        filtered = filtered.filter(
                            (d: any) =>
                                new Date(d.createdAt).toDateString() === target
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
                    `Unknown fetch type: ${String(type)}`
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
                        String(t.priority)
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
                    JSON.stringify({ type: "tasks", count: normalized.length })
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
                    JSON.stringify({ type: "document", title: doc.title })
                );
                res.set("X-Session-Id", sessionId);
                res.set("Access-Control-Expose-Headers", "X-Session-Id");
                return res.json({ type: "document", data: doc });
            }
        }

        // Fallback: textual HTML
        const html =
            textOutput && textOutput.trim().startsWith("<")
                ? textOutput
                : toHtmlParagraph(textOutput);
        sessionStore.appendTurn(sessionId, "model", html);
        res.set("X-Session-Id", sessionId);
        res.set("Access-Control-Expose-Headers", "X-Session-Id");
        return res.json({ type: "text", data: html });
    }
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
                                      categoryCatalog
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
                        fallbackCategory
                    );
                    return {
                        tempId: String(t.tempId || makeTmpId()),
                        title: t.title || "Untitled task",
                        description: t.description || "",
                        priority: ["low", "medium", "high"].includes(
                            String(t.priority)
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
        const rawHtml =
            textOutput && textOutput.trim().startsWith("<")
                ? textOutput
                : toHtmlParagraph(textOutput);
        const safe = enforceHtmlRules(sanitizeHtml(rawHtml)) || "<p></p>";

        res.set("X-Session-Id", sessionId);
        res.set("Access-Control-Expose-Headers", "X-Session-Id");
        return res.json({ type: "text", data: safe });
    }
);

const SYSTEM_NATIVE_GUIDE = `
You are an AI assistant for a React Native application.

You must output ONLY a JSON component tree with this schema:

==============================
=== ROOT JSON UI SCHEMA =====
==============================

A component is one of:

{
  "type": "view",
  "style"?: { ... },
  "children"?: Component[]
}

{
  "type": "text",
  "text": string,
  "style"?: { ... }
}

{
  "type": "button",
  "label": string,
  "action": string,
  "taskId"?: string,
  "documentId"?: string,
  "style"?: { ... }
}

{
  "type": "list",
  "items": Component[]
}

{
  "type": "task",
  "id": string,
  "title": string,
  "status": string,
  "priority": string
}

{
  "type": "document",
  "id": string,
  "title": string
}

Rules:
- NEVER output HTML.
- NEVER output <p>, <ol>, <li>, <a> or any HTML tag.
- NEVER output markdown or backticks.
- NEVER wrap JSON in code fences.
- Always output RAW JSON only.
- Always build a valid component tree.
- Use "text" for plain text.
- Use "view" with children for grouping.
- Use "list" for collections.
- Use "task" and "document" nodes for items.
- Use "button" only when user can take action.

Context rules:
- You have access to tasks, documents, categories, chats, focused chat, etc.
- When asked to fetch data, call fetch_data tool.
- When asked to create tasks, call create_tasks tool.
- When asked to create documents, call create_document tool.
- For chat/summarize, generate a JSON component tree representing the AI response visually.

==========================
=== THEME + STYLING ======
==========================

You MUST style components using ONLY the following tokens:

colors:
- primary (#0E1734)
- secondary (#F9F9F9)
- text (#222222)
- gray (#6b7280)
- bg (#FFFFFF)
- white (#FFFFFF)

fonts:
- Lato-Regular
- Lato-Bold
- Archivo-Medium
- Archivo-SemiBold

spacing:
- xs = 4
- sm = 8
- md = 12
- lg = 20
- xl = 28

radius:
- sm = 6
- md = 10
- lg = 16

Allowed style keys:
- padding, paddingHorizontal, paddingVertical
- margin, marginTop, marginBottom
- gap, rowGap, columnGap
- backgroundColor
- color
- borderRadius
- fontFamily
- fontSize
- flexDirection ("column" or "row")
- alignItems, justifyContent
- width, height

You may only use these style properties. Do NOT invent new properties.

Styling guidelines:
- Titles use fontFamily: "Archivo-SemiBold", fontSize: 18
- Regular text uses fontFamily: "Lato-Regular", fontSize: 15
- Buttons MUST use:
  - backgroundColor: primary
  - borderRadius: md
  - paddingVertical: sm
  - paddingHorizontal: md
  - text inside: color white, fontFamily Lato-Bold
- Views default to:
  - paddingVertical: sm
  - gap: sm

This theme styling MUST be used consistently across all output.

STRICT REQUIREMENT:
❗ STRICTLY OUTPUT ONLY PLAIN JSON — NO TEXT, NO HTML, NO MARKDOWN, NO MARKUP, NO MARKUP JSON OR NESTED JSON WITH ${"```json <JSON DATA HERE> ```"}.
`.trim();

export const aiNativeController = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { ai, Type } = await getGeminiClient();

        const userId = req.body.user ?? String(req.user?._id);
        const page: PageKind = (
            (req.body.page as string) || "general"
        ).toLowerCase() as PageKind;
        const id = req.body.id as string | undefined;
        const query = String(req.body.query || "");
        const explicitAction = req.body.action as string | undefined;

        // Session state
        const sessionId = getOrCreateSessionId(req);
        const session = await sessionStore.upsert(sessionId, userId);

        // Load workspace context (tasks, docs, etc)
        const workspaceContext = await buildContext({ userId, page, id });

        // Detect intent
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

        const sessionTurns = session.turns.map((t) => ({
            role: t.role,
            text: t.text,
        }));

        const finalSystemPrompt = `
${SYSTEM_NATIVE_GUIDE}

Available categories: ${JSON.stringify(workspaceContext.categories)}
`.trim();

        const userPrompt = `
Action: ${chosenAction}
Page: ${page}
Id: ${id ?? "(none)"}
User query: ${query || "(no query provided)"}
Platform: native

WorkspaceContext:
${JSON.stringify(workspaceContext).slice(0, 40000)}
`;

        const tools =
            chosenAction === "summarize" || chosenAction === "chat"
                ? undefined
                : {
                      tools: [
                          { functionDeclarations: buildToolDeclarations(Type) },
                      ],
                  };

        const contents: any[] = [
            { role: "user", parts: [{ text: finalSystemPrompt }] },
            ...sessionTurns.slice(-8).map((t) => ({
                role: t.role,
                parts: [{ text: t.text }],
            })),
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

        // Save memory of this turn
        if (query) sessionStore.appendTurn(sessionId, "user", query);

        // ----------------------------------------------
        // 📦 HANDLE TOOL CALLS (native version)
        // ----------------------------------------------
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

            // FETCH DATA
            if (fn.name === "fetch_data") {
                const { type, filters = {} } = args;

                if (type === "tasks") {
                    let filtered = workspaceContext.tasks.slice();
                    if (filters.priority)
                        filtered = filtered.filter(
                            (t: any) =>
                                String(t.priority).toLowerCase() ===
                                String(filters.priority).toLowerCase()
                        );
                    if (filters.status)
                        filtered = filtered.filter(
                            (t: any) =>
                                String(t.status).toLowerCase() ===
                                String(filters.status).toLowerCase()
                        );
                    if (filters.tag)
                        filtered = filtered.filter(
                            (t: any) =>
                                String(t.category).toLowerCase() ===
                                    String(filters.tag).toLowerCase() ||
                                String(t.categoryId) === String(filters.tag)
                        );

                    const json = buildNativeTasksJson(filtered);

                    sessionStore.appendTurn(
                        sessionId,
                        "model",
                        JSON.stringify(json)
                    );
                    res.set("X-Session-Id", sessionId);
                    res.set("Access-Control-Expose-Headers", "X-Session-Id");

                    return res.json({ type: "json", data: json });
                }

                if (type === "documents") {
                    let filtered = workspaceContext.documents.slice();

                    const json = buildNativeDocumentsJson(filtered);

                    sessionStore.appendTurn(
                        sessionId,
                        "model",
                        JSON.stringify(json)
                    );
                    res.set("X-Session-Id", sessionId);
                    res.set("Access-Control-Expose-Headers", "X-Session-Id");

                    return res.json({ type: "json", data: json });
                }
            }

            // CREATE TASKS
            if (fn.name === "create_tasks") {
                const tasks = Array.isArray(args.tasks) ? args.tasks : [];

                return res.json({
                    type: "tasks",
                    data: { tasks },
                });
            }

            // CREATE DOCUMENT
            if (fn.name === "create_document") {
                const doc = {
                    title: args.title,
                    content: args.content,
                    tag: args.tag,
                };
                return res.json({ type: "document", data: doc });
            }
        }

        // ----------------------------------------------
        // 📦 FALLBACK: model must output native JSON
        // ----------------------------------------------
        let jsonOut;
        try {
            jsonOut = JSON.parse(
                textOutput.replaceAll("```json", "").replaceAll("```", "")
            );
        } catch {
            jsonOut = buildJsonText(textOutput);
        }

        sessionStore.appendTurn(sessionId, "model", JSON.stringify(jsonOut));
        res.set("X-Session-Id", sessionId);
        res.set("Access-Control-Expose-Headers", "X-Session-Id");

        return res.json({ type: "json", data: jsonOut });
    }
);
