import { NextFunction, Request, Response } from "express";
import catchAsync from "../utils/catchAsync";
import TaskModel from "../model/taskModel";
import ChatModel from "../model/chatModel";
import DocumentModel from "../model/documentModel";
import { getGeminiClient, openai } from "../services/llm.service";
import { ChatCompletionTool } from "openai/resources/index.js";
import CategoryModel from "../model/categoryModel";
import { Schema, SchemaType } from "@google/generative-ai";
import MessageModel from "../model/messageModel";

export const aiController = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const ai = await getGeminiClient();
        const userId = req.user._id;
        const { query, id, page, action } = req.body;

        if (!["task", "chat", "document"].includes(String(page))) {
            return res.status(400).json({ error: "Invalid page type" });
        }

        const intentPrompt = `
You are an AI intent detector for a workspace assistant.

Your task is to classify the user's message into exactly one of these actions:

- "summarize" → The user wants a summary, explanation, or understanding of something.
  (Examples: "summarize this", "help me understand", "what’s the gist?", "explain this to me")

- "create_tasks" → The user explicitly asks to make or list actionable tasks, to-dos, steps, or plans.
  (Examples: "create a task", "plan my day", "generate a to-do list", "what should I do next?")

- "create_document" → The user requests writing or generating a document, report, or structured content.
  (Examples: "write a report", "generate a document", "create meeting notes")

- "chat" → Any conversational, open-ended, or clarification question that doesn’t fit the above categories.
  (Examples: "how are you?", "okay so what should I know?", "tell me more", "why is that important?")

Rules:
- Prefer "chat" by default when intent is ambiguous.
- Never infer a task or document unless the user explicitly asks to create or generate one.
- Output **only** a single valid JSON object like:
  { "action": "chat" }
   and no markup json

Now classify the user's latest message accordingly.
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
            console.warn("Failed to parse intent JSON, defaulting to chat.");
        }

        // 1) Load context from MongoDB (most recent 10)
        let data: any[] = [];
        if (page === "task") {
            data = await TaskModel.find({ user: userId })
                .populate("user status category")
                .sort({ createdAt: -1 })
                .lean();
        } else if (page === "chat") {
            data = await MessageModel.find({ chat: id })
                .populate("sender")
                .sort({ createdAt: -1 })
                .lean();
        } else if (page === "document" && !!id) {
            data = await DocumentModel.find({ _id: id, user: userId })
                .populate("tag user")
                .sort({ createdAt: -1 })
                .lean();
        } else {
            return res.json({
                type: "text",
                data: "Please select a document to continue",
            });
        }

        // categories available for assignment to tasks
        const categories = await CategoryModel.find({
            $or: [{ public: true }, { user: userId }],
        }).lean();

        // 2) Build function declarations (JSON Schema style per docs)
        const createTasksDeclaration = {
            name: "create_tasks",
            description:
                "Generate up to 10 structured, actionable tasks for the user. Each task must include a temporary ID (tempId), title, description, priority, and a valid category object from the provided categories list.",
            parameters: {
                type: "object",
                properties: {
                    tasks: {
                        type: "array",
                        description:
                            "List of generated tasks. Each task must include category details from the provided category list and a unique temporary ID starting with 'tmp-'.",
                        items: {
                            type: "object",
                            properties: {
                                tempId: {
                                    type: "string",
                                    description:
                                        "Randomly generated temporary unique ID for frontend tracking (e.g., 'tmp-8392afc1'). Not a database ID.",
                                },
                                title: {
                                    type: "string",
                                    description:
                                        "Short, descriptive task title.",
                                },
                                description: {
                                    type: "string",
                                    description:
                                        "Detailed explanation or purpose of the task.",
                                },
                                priority: {
                                    type: "string",
                                    enum: ["low", "medium", "high"],
                                    description:
                                        "The urgency level of the task: low, medium, or high.",
                                },
                                category: {
                                    type: "object",
                                    description:
                                        "Object containing the title and id of the chosen category. Must match one from the provided categories list.",
                                    properties: {
                                        title: {
                                            type: "string",
                                            description:
                                                "Category title as defined in the provided categories list.",
                                        },
                                        id: {
                                            type: "string",
                                            description:
                                                "MongoDB ObjectId of the category from the provided list. The field name must be exactly 'id' — do not rename or prefix it (e.g., not 'a_id', '_id', or 'categoryId').",
                                        },
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
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description:
                            "Concise, meaningful title for the document.",
                    },
                    content: {
                        type: "string",
                        description:
                            "Rich HTML-formatted body of the document (<h2>, <p>, <ul>, etc.).",
                    },
                    tag: {
                        type: "object",
                        description:
                            "Object representing the document's category. Must reference an existing category from the provided list.",
                        properties: {
                            title: {
                                type: "string",
                                description:
                                    "Category title chosen from the provided categories list.",
                            },
                            id: {
                                type: "string",
                                description:
                                    "MongoDB ObjectId of the chosen category from the provided list. The field name must be exactly 'id' — do not rename or prefix it (e.g., not 'a_id', '_id', or 'categoryId').",
                            },
                        },
                        required: ["title", "id"],
                    },
                },
                required: ["title", "content", "tag"],
            },
        };

        // 3) decide tools/config (only when not summarize)
        const config: any | undefined =
            String(action ?? inferredAction) === "summarize"
                ? undefined
                : {
                      tools: [
                          {
                              // function declarations are passed under tools[].functionDeclarations per docs
                              functionDeclarations: [
                                  createTasksDeclaration,
                                  createDocumentDeclaration,
                              ],
                          },
                      ],
                  };

        // 4) Compose prompt (system + user). Keep system short & concrete.
        const systemPrompt =
            `You are an AI assistant inside a workspace app that helps users manage tasks, chats, and documents.

You can perform four actions:

1. **summarize** — Summarize the provided Context (Mongo JSON) into plain, human-readable text.
   - Never ask clarifying questions; automatically summarize.
   - Prefer generating the output using HTML tags (<h2>, <p>, <ul>, etc.) rather than Markdown.
   - Be concise, accurate, and structured.

2. **create_tasks** — Generate up to 10 structured, actionable tasks in JSON format.
   - Each task must strictly follow this exact structure:
     {
       "tempId": "tmp-xxxxxx",           // a random short unique temporary ID
       "title": "Task title here",
       "description": "Brief but clear description of the task.",
       "priority": "high | medium | low",
       "category": {
         "title": "Category Title from provided list",
         "id": "Matching category ID from provided list"
       }
     }
   - Notes:
     - 'tempId' is mandatory and must start with "tmp-" followed by random alphanumeric characters (e.g., "tmp-2b9a7c3f").
     - The 'category' must be an **object** containing both 'title' and 'id' taken from the provided category list.
     - Do **not** return category as a string or invent new categories or IDs.
     - Choose the most suitable category based on the task’s purpose and context.
     - Use the Context data to infer what tasks are relevant.
     - If the user provides no specific query, suggest tasks automatically based on recent activity, missing steps, or incomplete items in Context.

3. **create_document** — Generate a document object containing:
   {
     "title": "Document title here",
     "tag": {
       "title": "Category Title from provided list",
       "id": "Matching category ID from provided list"
     },
     "content": "<h2>...</h2><p>...</p>"
   }
Notes:

The 'tag' must be an object with both 'title' and 'id', taken strictly from the provided categories.

Never create new categories or IDs.

Choose the most contextually appropriate tag.

If the user provides no query, infer a useful document from the Context (e.g., meeting summary, project overview, weekly report, progress update).
Use professional, concise language with rich HTML formatting.

chat — Engage in normal conversation with the user.

Used when the user is asking general questions, seeking clarification, or casually interacting.

Respond naturally and conversationally.

Do not produce structured data or formal JSON—just plain text or simple HTML.

Default to 'chat' when the user’s intent is unclear.

Rules:

Context data comes directly from MongoDB — interpret it meaningfully.

Categories: ${JSON.stringify(categories || [])}

Only use category IDs and titles from the list above. Never invent new ones.

Never ask the user for more input; make the best assumption with what’s provided.

Always return structured data when required ('create_tasks' and 'create_document') following the exact JSON structures shown above.

For 'chat' and 'summarize', return plain text or HTML output (not JSON).

Ensure categories/tags are contextually appropriate and consistent with the generated content.

Every task must include a valid 'tempId' starting with "tmp-".


IMPORTANT:
- The property name for the category or tag ID must be exactly 'id'.
- Do NOT output 'a_id', '_id', 'categoryId', or any variant.`.trim();

        const userPrompt = `
Action: ${action ?? inferredAction}
User query: ${query && query.trim().length > 0 ? query : "(no user query provided — generate intelligent suggestions automatically)"}

Context (raw Mongo JSON):
${JSON.stringify(data, null, 2).slice(0, 20000)}
`.trim();

        // 5) Call Gemini via the SDK:
        // docs show ai.models.generateContent({ model, contents, config })
        // use a "flash" model for speed/cost; swap to pro if you need more reasoning
        const modelName = "gemini-2.5-flash"; // or "gemini-2.5-pro" if you need higher reasoning

        const contents = [
            {
                role: "user",
                parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }],
            },
        ];

        const response = await ai.models.generateContent({
            model: modelName,
            contents,
            config,
            // optionally set generationConfig here (temperature, maxOutputTokens) if needed
        });

        // 6) Robustly extract text or function-calls
        // response may expose convenient helpers (response.text, response.functionCalls) depending on SDK version;
        // handle both possible shapes to be defensive.
        const textOutput =
            typeof response.text === "function"
                ? response.text
                : response.text ??
                  response.candidates?.[0]?.content?.parts
                      ?.map((p: any) => p.text ?? "")
                      .join("") ??
                  "";

        // functionCalls is the first-class API for function-calling per docs
        const functionCalls =
            response.functionCalls ??
            response.candidates?.[0]?.content?.parts
                ?.map((p: any) => p.function_call)
                .filter(Boolean) ??
            [];

        console.log(inferredAction);
        console.log(JSON.stringify(response, null, 2));

        if (["summarize", "chat"].includes(String(action ?? inferredAction))) {
            res.set("X-Message", "");
            res.set("Access-Control-Expose-Headers", "X-Message");
            return res.json({ type: "text", data: textOutput });
        }

        // If there is a function call, return parsed args
        if (functionCalls && functionCalls.length > 0) {
            const fn = functionCalls[0];
            const args = fn.args ?? fn.arguments ?? {}; // some SDK variations use args vs arguments

            res.set("X-Message", "message");
            res.set("Access-Control-Expose-Headers", "X-Message");
            return res.json({
                type:
                    String(action ?? inferredAction) === "create_tasks"
                        ? "tasks"
                        : "document",
                data: args,
            });
        }

        // fallback: return plain text if model didn't choose a function call
        res.set("X-Message", "");
        res.set("Access-Control-Expose-Headers", "X-Message");
        return res.json({ type: "text", data: textOutput });
    }
);
