import TaskModel from "../model/taskModel";
import DocumentModel from "../model/documentModel";
import MessageModel from "../model/messageModel";
import CategoryModel from "../model/categoryModel";

export type PageKind = "general" | "document" | "chat";

export async function buildContext(opts: {
    userId: string;
    page: PageKind;
    id?: string; // documentId for document, chatId for chat
}) {
    const { userId, page, id } = opts;

    const [tasksRaw, documentsRaw, categories] = await Promise.all([
        TaskModel.find({ user: userId })
            .populate("status category user")
            .sort({ createdAt: -1 })
            .lean(),
        DocumentModel.find({ user: userId })
            .populate("tag user")
            .sort({ createdAt: -1 })
            .lean(),
        CategoryModel.find({
            $or: [{ public: true }, { user: userId }],
        }).lean(),
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
        excerpt:
            typeof d.content === "string" ? d.content.substring(0, 300) : "",
        tag: d.tag?.title || d.tag || "",
        tagId: d.tag?._id ? String(d.tag._id) : undefined,
        createdAt: d.createdAt,
        url: `/documents?document=${String(d._id)}`,
    }));

    // Page‑specific enrichments
    let focusDocument: any = null;
    let focusChat: { id: string; messages: any[] } | null = null;

    if (page === "document" && id) {
        const doc = documentsRaw.find((d: any) => String(d._id) === String(id));
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
        const messages = await MessageModel.find({ chat: id, type: "text" })
            .populate("sender")
            .sort({ createdAt: 1 })
            .lean();
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
