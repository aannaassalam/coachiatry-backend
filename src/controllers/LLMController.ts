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
            const chat = await ChatModel.findOne({
                members: { $all: [userId, id] },
            }).lean();
            data = await MessageModel.find({ chat: chat._id })
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
                "Generate up to 10 structured tasks for the user and fill up priority category and status based on your observation, just make sure you take reference for category from categories list.",
            parameters: {
                type: "object",
                properties: {
                    tasks: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                title: { type: "string" },
                                description: { type: "string" },
                                category: {
                                    type: "string",
                                    description:
                                        "Mongo ObjectId from provided categories",
                                },
                                priority: {
                                    type: "string",
                                    enum: ["low", "medium", "high"],
                                },
                            },
                            required: ["title", "description", "priority"],
                        },
                    },
                },
                required: ["tasks"],
            },
        };

        const createDocumentDeclaration = {
            name: "create_document",
            description:
                "Generate a document object with title and HTML content",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string" },
                    content: {
                        type: "string",
                        description:
                            "HTML-formatted rich text for the document body",
                    },
                },
                required: ["title", "content"],
            },
        };

        // 3) decide tools/config (only when not summarize)
        const config: any | undefined =
            String(action) === "summarize"
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
        const systemPrompt = `
You are an AI assistant inside a workspace app that helps users manage tasks, chats, and documents.

You can perform four actions:

1. **summarize** — Summarize the provided Context (Mongo JSON) into plain, human-readable text.
   - Never ask clarifying questions; automatically summarize.
   - Prefer generating the output using HTML tags (<h2>, <p>, <ul>, etc.) rather than Markdown.
   - Be concise, accurate, and structured.

2. **create_tasks** — Generate up to 10 structured, actionable tasks in JSON format.
   - Use the Context data to infer what tasks are relevant.
   - If the user provides no specific query, suggest tasks automatically based on recent activity, missing steps, or incomplete items in Context.
   - Use provided categories when possible and set a logical priority (high, medium, low).

3. **create_document** — Generate a document object containing:
   - A clear 'title'
   - A detailed 'content' field in rich HTML (<h2>, <p>, <ul>).
   - If the user provides no query, infer a useful document from the Context, such as a meeting summary, project overview, weekly report, or progress update.
   - Use professional, concise language.

4. **chat** — Engage in normal conversation with the user.
   - Used when the user is asking general questions, seeking clarification, or casually interacting.
   - Respond naturally and conversationally.
   - Do **not** produce structured data or formal JSON—just plain text or simple HTML.
   - Default to 'chat' when the user’s intent is unclear.

Rules:
- Context data comes directly from MongoDB — interpret it meaningfully.
- Categories: ${JSON.stringify(categories || [])}
- Only use category IDs listed above; do not invent new ones.
- Never ask the user for more input; make the best assumption with what’s provided.
- Always return structured data when required ('create_tasks' and 'create_document').
- For 'chat' and 'summarize', return plain text or HTML output (not JSON).

`.trim();

        const userPrompt = `
Action: ${action || inferredAction}
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

        if (["summarize", "chat"].includes(String(action ?? inferredAction))) {
            res.set("X-Message", "");
            res.set("Access-Control-Expose-Headers", "X-Message");
            return res.json({ type: "text", data: textOutput });
        }

        // If there is a function call, return parsed args
        if (functionCalls && functionCalls.length > 0) {
            const fn = functionCalls[0];
            const args = fn.args ?? fn.arguments ?? {}; // some SDK variations use args vs arguments
            // OPTIONAL: Validate args schema here before returning / saving.
            // If autoSave = true, persist to DB (validate category IDs and fields).
            // if (
            //     autoSave &&
            //     String(action) === "create_tasks" &&
            //     Array.isArray(args.tasks)
            // ) {
            //     // validate each task and insert (example)
            //     const toInsert = args.tasks.map((t: any) => ({
            //         title: t.title,
            //         description: t.description,
            //         category:
            //             t.category &&
            //             categories.some(
            //                 (c: any) => String(c._id) === String(t.category)
            //             )
            //                 ? t.category
            //                 : undefined,
            //         priority: ["low", "medium", "high"].includes(t.priority)
            //             ? t.priority
            //             : "medium",
            //         owner: userId,
            //     }));
            //     // insertMany but be careful with schema & validation in production
            //     await TaskModel.insertMany(toInsert);
            // } else if (
            //     autoSave &&
            //     String(action) === "create_document" &&
            //     args.title &&
            //     args.content
            // ) {
            //     await DocumentModel.create({
            //         title: args.title,
            //         content: args.content,
            //         owner: userId,
            //     });
            // }
            res.set("X-Message", "message");
            res.set("Access-Control-Expose-Headers", "X-Message");
            return res.json({
                type: String(action) === "create_tasks" ? "tasks" : "document",
                data: args,
            });
        }

        // fallback: return plain text if model didn't choose a function call
        res.set("X-Message", "");
        res.set("Access-Control-Expose-Headers", "X-Message");
        return res.json({ type: "text", data: textOutput });
    }
);
