import TaskModel from "../model/taskModel";
import DocumentModel from "../model/documentModel";
import MessageModel from "../model/messageModel";
import { findCategoriesCached } from "../utils/referenceData";

export type PageKind = "general" | "document" | "chat";

// How much of a document body survives into the workspace summary. Must match
// the excerpt length the projection below asks Mongo for.
const EXCERPT_CHARS = 300;

// Caps on how much of a workspace goes into a prompt. The whole context is
// JSON.stringify'd and sliced to 40k chars by the callers in LLMController, so
// reading an entire unbounded workspace off disk only to throw nearly all of it
// away was pure waste — a few hundred of the most recent rows is far more than
// survives the slice.
const MAX_CONTEXT_ROWS = 200;
const MAX_CHAT_MESSAGES = 500;

export async function buildContext(opts: {
    userId: string;
    page: PageKind;
    id?: string; // documentId for document, chatId for chat
    chatDateFrom?: Date; // optional lower bound when filtering chat history
}) {
    const { userId, page, id, chatDateFrom } = opts;

    const [tasksRaw, documentsRaw, categories] = await Promise.all([
        // `user` was populated only to read `t.user.name`, which does not exist
        // on the user schema (the field is `fullName`), so `assignee` was always
        // "" — the join was dead weight on every row.
        TaskModel.find({ user: userId })
            .populate("status category")
            .sort({ createdAt: -1 })
            .limit(MAX_CONTEXT_ROWS)
            .lean(),
        // Ask Mongo for the excerpt rather than shipping whole document bodies
        // over the wire to call .substring(0, 300) on them here. This was the
        // heaviest read in the app: megabytes of HTML per AI request to produce
        // a few KB of prompt.
        DocumentModel.find(
            { user: userId },
            {
                title: 1,
                tag: 1,
                createdAt: 1,
                // $substrCP counts code points, so it matches what
                // String.substring() used to return here. ($substrBytes would
                // slice mid-character on any non-ASCII content.)
                excerpt: {
                    $substrCP: [{ $ifNull: ["$content", ""] }, 0, EXCERPT_CHARS],
                },
            }
        )
            .populate("tag")
            .sort({ createdAt: -1 })
            .limit(MAX_CONTEXT_ROWS)
            .lean(),
        findCategoriesCached({
            $or: [{ public: true }, { user: userId }],
        }),
    ]);

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
        url: `/tasks?task=${String(t._id)}`,
    }));

    const documents = (documentsRaw || []).map((d: any) => ({
        id: String(d._id),
        title: d.title,
        excerpt: d.excerpt || "",
        tag: d.tag?.title || d.tag || "",
        tagId: d.tag?._id ? String(d.tag._id) : undefined,
        createdAt: d.createdAt,
        url: `/documents?document=${String(d._id)}`,
    }));

    // Page‑specific enrichments
    let focusDocument: any = null;
    let focusChat: { id: string; messages: any[] } | null = null;

    if (page === "document" && id) {
        // Fetched on its own now that the list carries excerpts instead of full
        // bodies. Still scoped to `user` so this can't read someone else's
        // document — the old code got that for free by searching the user's own
        // list, and dropping the filter here would have been a quiet hole.
        const doc: any = await DocumentModel.findOne({ _id: id, user: userId })
            .populate("tag")
            .lean();
        if (doc) {
            focusDocument = {
                id: String(doc._id),
                title: doc.title,
                content: doc.content,
                tag: (doc.tag as any)?.title || doc.tag || "",
                createdAt: doc.createdAt,
                url: `/documents?document=${String(doc._id)}`,
            };
        }
    }

    if (page === "chat" && id) {
        const messageQuery: any = { chat: id, type: "text" };
        if (chatDateFrom) {
            messageQuery.createdAt = { $gte: chatDateFrom };
        }

        // Only `sender._id` is read below, so pulling whole user documents (each
        // carrying otp/reset-token fields) per message was needless.
        // Newest-first + limit, then reversed back to chronological order: an
        // unbounded fetch meant a long chat loaded every message ever sent, and
        // the callers' 40k-char slice then kept only the OLDEST ones.
        const messages = await MessageModel.find(messageQuery)
            .populate({ path: "sender", select: "_id" })
            .sort({ createdAt: -1 })
            .limit(MAX_CHAT_MESSAGES)
            .lean();
        messages.reverse();
        focusChat = {
            id: String(id),
            messages: messages.map((m: any) => ({
                id: String(m._id),
                role: String(m.sender?._id) === userId ? "user" : "friend",
                text: m.content || "",
                createdAt: m.createdAt,
            })),
        };
    }

    return {
        overview: {
            totalTasks: tasks.length,
            totalDocuments: documents.length,
            totalCategories: (categories || []).length,
        },
        page,
        focusDocument,
        focusChat,
        categories: (categories || []).map((c: any) => ({
            id: String(c._id),
            title: c.title || c.name || "Untitled",
            public: !!c.public,
        })),
        tasks,
        documents,
    };
}
