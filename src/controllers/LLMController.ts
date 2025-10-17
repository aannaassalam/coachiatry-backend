// aiController.ts
import { Request, Response, NextFunction } from "express";
import { uuid } from "uuidv4"; // optional; or use your own generator
import catchAsync from "../utils/catchAsync";
import { getGeminiClient } from "../services/llm.service";
import TaskModel from "../model/taskModel";
import DocumentModel from "../model/documentModel";
import MessageModel from "../model/messageModel";
import CategoryModel from "../model/categoryModel";
import DOMPurify from "isomorphic-dompurify";

const escapeHtml = (content: string) =>
    DOMPurify.sanitize(content, {
        ALLOWED_TAGS: ["p", "h2", "h3", "b", "i", "ul", "li", "a", "div", "br"],
        ALLOWED_ATTR: ["href", "class"],
    });

export const aiController = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { ai, Type } = await getGeminiClient();
        const userId = req.user._id;
        const { query, id, page, action } = req.body;

        // Acceptable pages still validated but we will provide global context anyway
        if (!["task", "chat", "document"].includes(String(page))) {
            // not fatal — allow but warn; keeping backward compatibility
            // return res.status(400).json({ error: "Invalid page type" });
        }

        // -----------------------------
        // 1) Load *all* workspace data
        // -----------------------------
        const [tasksRaw, documentsRaw, messagesRaw, categories] =
            await Promise.all([
                TaskModel.find({ user: userId })
                    .populate("status category user")
                    .sort({ createdAt: -1 })
                    .lean(),
                DocumentModel.find({ user: userId })
                    .populate("tag user")
                    .sort({ createdAt: -1 })
                    .lean(),
                MessageModel.find({
                    $or: [{ "chat.user": userId }, { sender: userId }],
                })
                    .populate("sender chat")
                    .sort({ createdAt: -1 })
                    .lean(),
                CategoryModel.find({
                    $or: [{ public: true }, { user: userId }],
                }).lean(),
            ]);

        // Normalize categories map for quick lookup
        const categoriesById = (categories || []).reduce<Record<string, any>>(
            (acc, c: any) => {
                acc[String(c._id)] = c;
                return acc;
            },
            {}
        );

        // Build compact, AI-friendly workspace context (string-length aware)
        // Only include essential fields so prompt isn't huge. Keep full arrays but trimmed if very large.
        const tasks = (tasksRaw || []).map((t: any) => ({
            id: String(t._id),
            title: t.title,
            description: t.description || "",
            priority: t.priority || t.priorityLevel || "medium",
            status: t.status?.title || t.status || "",
            category: t.category?.title || t.category?.name || "",
            categoryId: t.category?._id ? String(t.category._id) : undefined,
            assignee: t.user?.name || t.assignee?.name || "",
            createdAt: t.createdAt,
            dueDate: t.dueDate || null,
            url: `/task?task=${String(t._id)}`,
        }));

        const documents = (documentsRaw || []).map((d: any) => ({
            id: String(d._id),
            title: d.title,
            excerpt:
                typeof d.content === "string"
                    ? d.content.substring(0, 300)
                    : "",
            tag: d.tag?.title || d.tag || "",
            tagId: d.tag?._id ? String(d.tag._id) : undefined,
            createdAt: d.createdAt,
            url: `/documents?document=${String(d._id)}`,
        }));

        const chats = (messagesRaw || []).slice(-200).map((m: any) => ({
            id: m._id ? String(m._id) : undefined,
            chatId: m.chat?._id ? String(m.chat._id) : undefined,
            sender: m.sender?.name || "unknown",
            message: m.content || m.text || "",
            createdAt: m.createdAt,
        }));

        const workspaceContext = {
            overview: {
                totalTasks: tasks.length,
                totalDocuments: documents.length,
                totalChats: chats.length,
                totalCategories: (categories || []).length,
            },
            categories: (categories || []).map((c: any) => ({
                id: String(c._id),
                title: c.title || c.name || "Untitled",
                public: !!c.public,
            })),
            tasks,
            documents,
            chats,
        };

        // -----------------------------
        // 2) Intent detector (re-use your existing prompt)
        // -----------------------------
        const intentPrompt = `
You are an AI intent detector for a workspace assistant.

Your task is to classify the user's message into exactly one of these actions:

- "summarize" → The user wants a summary, explanation, or understanding of something.
- "create_tasks" → The user explicitly asks to make or list actionable tasks, to-dos, steps, or plans.
- "create_document" → The user requests writing or generating a document, report, or structured content.
- "fetch_data" → The user explicitly asks to "show", "get", "list", or "find" tasks/documents with filters (dates, tags, priorities).
- "chat" → Any conversational, open-ended, or clarification question that doesn’t fit the above categories.

Rules:
- Prefer "chat" by default when intent is ambiguous.
- Never infer a task or document unless the user explicitly asks to create or generate one.
- Output only a single valid parsable JSON object like: { "action": "chat" } no json markup allowed.
`.trim();

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
            intentResponse.text ??
            intentResponse.candidates?.[0]?.content?.parts
                ?.map((p: any) => p.text ?? "")
                .join("") ??
            "";

        let inferredAction = "chat";
        try {
            inferredAction = JSON.parse(intentText).action;
        } catch (e) {
            console.warn("Failed to parse intent JSON, defaulting to chat.", e);
        }

        // If frontend explicitly passed an action, prefer it
        const chosenAction = String(action ?? inferredAction);

        // -----------------------------
        // 3) Function declarations (create_tasks, create_document, fetch_data)
        // -----------------------------
        const createTasksDeclaration = {
            name: "create_tasks",
            description:
                "Generate up to 10 structured, actionable tasks for the user. Each task must include a temporary ID (tempId), title, description, priority, and a valid category object from the provided categories list.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    tasks: {
                        type: Type.ARRAY,
                        description:
                            "List of generated tasks. Each task must include category details from the provided category list and a unique temporary ID starting with 'tmp-'.",
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                tempId: { type: Type.STRING },
                                title: { type: Type.STRING },
                                description: { type: Type.STRING },
                                priority: {
                                    type: Type.STRING,
                                    format: "enum",
                                    enum: ["low", "medium", "high"],
                                },
                                category: {
                                    type: Type.OBJECT,
                                    properties: {
                                        title: { type: Type.STRING },
                                        id: { type: Type.STRING },
                                    },
                                    required: ["title", "id"],
                                },
                            },
                            required: [
                                "tempId",
                                "title",
                                "description",
                                "priority",
                                "category",
                            ],
                        },
                    },
                },
                required: ["tasks"],
            },
        };

        const createDocumentDeclaration = {
            name: "create_document",
            description:
                "Generate a document object with a title, HTML-formatted content, and a tag object referencing a valid category from the provided categories list.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING },
                    content: { type: Type.STRING },
                    tag: {
                        type: Type.OBJECT,
                        properties: {
                            title: { type: Type.STRING },
                            id: { type: Type.STRING },
                        },
                        required: ["title", "id"],
                    },
                },
                required: ["title", "content", "tag"],
            },
        };

        const fetchDataDeclaration = {
            name: "fetch_data",
            description:
                "Retrieve filtered data (tasks or documents) from the workspace context based on user query. Returns a JSON object describing domain and filters.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    type: {
                        type: Type.STRING,
                        format: "enum",
                        enum: ["tasks", "documents"],
                        description: "Which domain to fetch",
                    },
                    filters: {
                        type: Type.OBJECT,
                        description: "Filter parameters for the domain",
                        properties: {
                            date: {
                                type: Type.STRING,
                                description:
                                    "ISO date or readable date (e.g., 2025-10-30)",
                            },
                            priority: {
                                type: Type.STRING,
                                format: "enum",
                                enum: ["low", "medium", "high"],
                            },
                            tag: { type: Type.STRING },
                            status: { type: Type.STRING },
                            limit: { type: Type.INTEGER },
                        },
                    },
                },
                required: ["type"],
            },
        };

        // -----------------------------
        // 4) Compose system + user prompt (global context attached)
        // -----------------------------
        const systemPrompt = `
You are an AI assistant that has full access to a user's workspace context (tasks, documents, chats, categories).
- Use the provided workspaceContext to answer questions, fetch items, or create new tasks/documents.
- Always prefer data from workspaceContext. Do NOT invent task IDs or category IDs.
- When returning user-facing answers, return HTML. For lists of tasks/documents include clickable links:
  - Task link: <a href="/task?task=TASK_ID">Task Title</a>
  - Document link: <a href="/documents?document=DOCUMENT_ID">Document Title</a>
- When describing **step-by-step instructions, tasks, documents, plans, or sequences**, use an **ordered list (<ol>)** instead of <ul>.
  Example:
  <ol>
    <li>Step one</li>
    <li>Step two</li>
  </ol>
- When fetching a list of information like tasks or documents and don't send just list items with 'ol' or 'ul', use an **ordered list (<ol>)** instead of <ul>.
  Example:
  <ol>
    <li>Task 1</li>
    <li>Task 2</li>
  </ol>
- When listing general items, options, or unordered details, use <ul>.
- If the user asks to "show", "get", "list", "find" or similar — use the 'fetch_data' function.
- If the user asks to "create" tasks or documents use 'create_tasks' or 'create_document' function outputs.
- For summaries or conversational answers, return HTML (no JSON).
- Every list generated must use <ol> — never use <ul> or bare <li> tags.
  - All <li> elements must be enclosed inside an <ol> block.
  - Never generate list items outside of <ol>.

Available categories: ${JSON.stringify(workspaceContext.categories || [])}
Note: Category object must use property name 'id' for the category id.
`.trim();

        const userPrompt = `
Action (frontend or inferred): ${chosenAction}
User query: ${query && query.trim().length ? query : "(no user query provided — infer helpful suggestions automatically)"}

Workspace Context (compact):
${JSON.stringify(workspaceContext, null, 2).slice(0, 20000)}
`.trim();

        // 5) Call the model (attach tool declarations unless action === summarize/chat)
        const modelName = "gemini-2.5-flash";
        const toolsConfig =
            chosenAction === "summarize" || chosenAction === "chat"
                ? undefined
                : {
                      tools: [
                          {
                              functionDeclarations: [
                                  createTasksDeclaration,
                                  createDocumentDeclaration,
                                  fetchDataDeclaration,
                              ],
                          },
                      ],
                  };

        const contents = [
            {
                role: "user",
                parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }],
            },
        ];

        const response = await ai.models.generateContent({
            model: modelName,
            contents,
            config: toolsConfig,
        });

        // 6) Extract text and function calls robustly
        const textOutput =
            typeof response.text === "function"
                ? response.text
                : response.text ??
                  response.candidates?.[0]?.content?.parts
                      ?.map((p: any) => p.text ?? "")
                      .join("") ??
                  "";

        const functionCalls =
            response.functionCalls ??
            response.candidates?.[0]?.content?.parts
                ?.map((p: any) => p.function_call)
                .filter(Boolean) ??
            [];

        // Helper: create tmp id
        const makeTmpId = () => `tmp-${uuid()}`;

        // Helper: build HTML list for tasks/documents
        const buildTasksHtml = (taskList: any[]) =>
            taskList.length
                ? `<div class="ai-results">${taskList
                      .map(
                          (t) =>
                              `<div class="ai-item"><a href="${t.url}">${escapeHtml(t.title)}</a> ${t.priority ? `— ${escapeHtml(t.priority)}` : ""} ${t.category ? `• ${escapeHtml(t.category)}` : ""}</div>`
                      )
                      .join("")}</div>`
                : `<p>No matching tasks found.</p>`;

        const buildDocumentsHtml = (docList: any[]) =>
            docList.length
                ? `<div class="ai-results">${docList
                      .map(
                          (d) =>
                              `<div class="ai-item"><a href="${d.url}">${escapeHtml(d.title)}</a> ${d.tag ? `— ${escapeHtml(d.tag)}` : ""}</div>`
                      )
                      .join("")}</div>`
                : `<p>No matching documents found.</p>`;

        // If action is a simple chat or summarize, return HTML text
        if (["summarize", "chat"].includes(chosenAction)) {
            res.set("X-Message", "");
            res.set("Access-Control-Expose-Headers", "X-Message");

            // Ensure HTML. If model returned plain text, wrap in <p>
            const html =
                textOutput && textOutput.trim().startsWith("<")
                    ? textOutput
                    : `<div class="ai-text"><p>${escapeHtml(textOutput)}</p></div>`;
            return res.json({ type: "text", data: html });
        }

        // If model invoked a function via functionCalls — handle them server-side
        if (functionCalls && functionCalls.length > 0) {
            const fn = functionCalls[0];
            // args sometimes stringified
            let args = fn.args ?? fn.arguments ?? fn.payload ?? {};
            if (typeof args === "string") {
                try {
                    args = JSON.parse(args);
                } catch (e) {
                    args = {};
                }
            }

            // HANDLE: fetch_data
            if (fn.name === "fetch_data") {
                const { type, filters = {} } = args;
                if (type === "tasks") {
                    let filtered = tasks.slice(); // from memory
                    if (filters.priority)
                        filtered = filtered.filter(
                            (t) =>
                                String(t.priority).toLowerCase() ===
                                String(filters.priority).toLowerCase()
                        );
                    if (filters.status)
                        filtered = filtered.filter(
                            (t) =>
                                String(t.status).toLowerCase() ===
                                String(filters.status).toLowerCase()
                        );
                    if (filters.tag) {
                        // match by category or categoryId
                        filtered = filtered.filter(
                            (t) =>
                                String(t.category).toLowerCase() ===
                                    String(filters.tag).toLowerCase() ||
                                String(t.categoryId) === String(filters.tag)
                        );
                    }
                    if (filters.date) {
                        const target = new Date(filters.date).toDateString();
                        filtered = filtered.filter(
                            (t) =>
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
                    res.set("X-Message", "fetch");
                    res.set("Access-Control-Expose-Headers", "X-Message");
                    return res.json({ type: "text", data: html });
                }

                if (type === "documents") {
                    let filtered = documents.slice();
                    if (filters.tag)
                        filtered = filtered.filter(
                            (d) =>
                                String(d.tag).toLowerCase() ===
                                    String(filters.tag).toLowerCase() ||
                                String(d.tagId) === String(filters.tag)
                        );
                    if (filters.date) {
                        const target = new Date(filters.date).toDateString();
                        filtered = filtered.filter(
                            (d) =>
                                new Date(d.createdAt).toDateString() === target
                        );
                    }
                    if (filters.limit)
                        filtered = filtered.slice(0, filters.limit);

                    const html = buildDocumentsHtml(filtered);
                    res.set("X-Message", "fetch");
                    res.set("Access-Control-Expose-Headers", "X-Message");
                    return res.json({ type: "text", data: html });
                }

                // unknown type
                res.set("X-Message", "");
                res.set("Access-Control-Expose-Headers", "X-Message");
                return res.json({
                    type: "text",
                    data: `<p>Unknown fetch type: ${escapeHtml(String(type))}</p>`,
                });
            }

            // HANDLE: create_tasks (return args to frontend as structured JSON)
            if (fn.name === "create_tasks") {
                // Model should provide args.tasks array; validate and fix missing tempId
                const tasksArg = Array.isArray(args.tasks) ? args.tasks : [];
                const normalized = tasksArg.map((t: any) => {
                    const tempId =
                        t.tempId && String(t.tempId).startsWith("tmp-")
                            ? t.tempId
                            : makeTmpId();
                    // ensure category object uses 'id'
                    const category = t.category
                        ? {
                              title: t.category.title || "",
                              id: String(t.category.id || t.category._id || ""),
                          }
                        : null;
                    return {
                        tempId,
                        title: t.title || "Untitled task",
                        description: t.description || "",
                        priority: ["low", "medium", "high"].includes(
                            String(t.priority)
                        )
                            ? t.priority
                            : "medium",
                        category,
                    };
                });

                res.set("X-Message", "message");
                res.set("Access-Control-Expose-Headers", "X-Message");
                return res.json({ type: "tasks", data: { tasks: normalized } });
            }

            // HANDLE: create_document
            if (fn.name === "create_document") {
                // Model should return title, content (HTML), tag (object with id & title)
                const doc = {
                    title: args.title || "Untitled Document",
                    content: args.content || "<p></p>",
                    tag: args.tag
                        ? {
                              title: args.tag.title || "",
                              id: String(args.tag.id || args.tag._id || ""),
                          }
                        : null,
                };

                res.set("X-Message", "message");
                res.set("Access-Control-Expose-Headers", "X-Message");
                return res.json({ type: "document", data: doc });
            }

            // Unknown function call: return text fallback
            res.set("X-Message", "");
            res.set("Access-Control-Expose-Headers", "X-Message");
            const fallbackHtml =
                textOutput && textOutput.trim().startsWith("<")
                    ? textOutput
                    : `<p>${escapeHtml(textOutput)}</p>`;
            return res.json({ type: "text", data: fallbackHtml });
        }

        // Fallback: model did not call function — return model text as HTML
        res.set("X-Message", "");
        res.set("Access-Control-Expose-Headers", "X-Message");
        const fallbackHtml =
            textOutput && textOutput.trim().startsWith("<")
                ? textOutput
                : `<div class="ai-text"><p>${escapeHtml(textOutput)}</p></div>`;
        return res.json({ type: "text", data: fallbackHtml });
    }
);

export default aiController;
