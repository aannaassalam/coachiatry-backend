export function buildToolDeclarations(Type: any) {
    const recurrenceEnum = [
        "none",
        "daily",
        "weekly",
        "monthly",
        "yearly",
    ] as const;

    const createTasksDeclaration = {
        name: "create_tasks",
        description:
            "Generate ~10 actionable task suggestions for the user. Use when the user clicks 'Create Tasks' or asks for new task ideas. Behavior: inspect workspaceContext.tasks for the user's existing categories, themes, and frequencies; generate NEW tasks that complement or extend those patterns (do NOT duplicate existing task titles). Skew categories toward what the user already uses. Each task needs: tempId, title, description, priority, category (id must exist in workspace categories), and dueDate. dueDate must be ISO 8601 with time aligned to HH:00 or HH:30 only (never arbitrary minutes).",
        parameters: {
            type: Type.OBJECT,
            properties: {
                tasks: {
                    type: Type.ARRAY,
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
                            dueDate: {
                                type: Type.STRING,
                                description:
                                    "ISO 8601 format including time. Allowed times must be either HH:00 or HH:30 only. Example: 2025-10-30T14:30:00.000Z",
                            },
                            recurrence: {
                                type: Type.STRING,
                                format: "enum",
                                enum: recurrenceEnum as unknown as string[],
                            },
                            category: {
                                type: Type.OBJECT,
                                properties: {
                                    title: { type: Type.STRING },
                                    id: { type: Type.STRING },
                                },
                                required: ["title", "id"],
                            },
                            subtasks: {
                                type: Type.ARRAY,
                                items: {
                                    type: Type.OBJECT,
                                    properties: {
                                        title: { type: Type.STRING },
                                        description: { type: Type.STRING },
                                        done: { type: Type.BOOLEAN },
                                    },
                                    required: ["title"],
                                },
                            },
                        },
                        required: [
                            "tempId",
                            "title",
                            "description",
                            "priority",
                            "category",
                            "dueDate",
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
            "Generate a single document for the user. Use when the user clicks 'Create Document' or asks to draft. Behavior: if the user gives an explicit topic, write on that topic. If no topic is given, infer the dominant theme from the user's data — analyze category distribution across workspaceContext.tasks AND tag distribution across workspaceContext.documents, then pick a topic that bridges the top 1-2 themes (e.g. many sports docs + sports-leaning tasks → write a sports-and-health crossover guide). The 'content' field must be valid HTML using ONLY this tag whitelist: <p>, <div>, <b>, <strong>, <i>, <em>, <u>, <s>, <del>, <ol>, <ul>, <li>, <a>. Emoji (unicode characters) are allowed inline. NO heading tags (<h1>-<h6>), NO <br>, NO tables, NO code/pre, NO blockquote, NO images, NO any other tag. Use <p> or <div> for structure and section breaks instead of headings — make a section's first line bold (<b> or <strong>) if you need emphasis. tag.id must exist in workspace categories.",
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

    const listTasksDeclaration = {
        name: "list_tasks",
        description:
            "List the current user's tasks. Use when the user asks to see, find, or filter their tasks/todos. Supports filters by priority, status, category, due-date window, and free-text search.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                priority: {
                    type: Type.STRING,
                    format: "enum",
                    enum: ["low", "medium", "high"],
                },
                status: {
                    type: Type.STRING,
                    description: "Status ObjectId from workspace context",
                },
                category: {
                    type: Type.STRING,
                    description: "Category ObjectId from workspace context",
                },
                frequency: {
                    type: Type.STRING,
                    format: "enum",
                    enum: recurrenceEnum as unknown as string[],
                },
                dueBefore: {
                    type: Type.STRING,
                    description: "ISO date — return tasks due before this",
                },
                dueAfter: {
                    type: Type.STRING,
                    description: "ISO date — return tasks due after this",
                },
                search: {
                    type: Type.STRING,
                    description: "Free-text match on task title",
                },
                limit: { type: Type.INTEGER },
            },
        },
    };

    const listDocumentsDeclaration = {
        name: "list_documents",
        description:
            "List documents visible to the current user. tab='all' returns owned plus shared, 'my-docs' returns owned only, 'shared' returns shared-with-user only.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                tab: {
                    type: Type.STRING,
                    format: "enum",
                    enum: ["all", "my-docs", "shared"],
                },
                tag: {
                    type: Type.STRING,
                    description: "Category/tag ObjectId",
                },
                search: {
                    type: Type.STRING,
                    description: "Free-text match on document title",
                },
                limit: { type: Type.INTEGER },
            },
        },
    };

    const editTaskDeclaration = {
        name: "edit_task",
        description:
            "Update fields on an existing task owned by the current user. Persists immediately to the database. Only include fields you want to change.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                taskId: {
                    type: Type.STRING,
                    description: "ObjectId of the task to update",
                },
                title: { type: Type.STRING },
                description: { type: Type.STRING },
                priority: {
                    type: Type.STRING,
                    format: "enum",
                    enum: ["low", "medium", "high"],
                },
                dueDate: {
                    type: Type.STRING,
                    description:
                        "ISO 8601 datetime aligned to HH:00 or HH:30 only",
                },
                category: {
                    type: Type.STRING,
                    description: "Category ObjectId",
                },
                status: {
                    type: Type.STRING,
                    description: "Status ObjectId",
                },
                frequency: {
                    type: Type.STRING,
                    format: "enum",
                    enum: recurrenceEnum as unknown as string[],
                },
                remindBefore: {
                    type: Type.NUMBER,
                    description: "Minutes before dueDate to remind",
                },
                taskDuration: { type: Type.NUMBER },
                active: { type: Type.BOOLEAN },
                subtasks: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            title: { type: Type.STRING },
                            completed: { type: Type.BOOLEAN },
                        },
                        required: ["title"],
                    },
                },
            },
            required: ["taskId"],
        },
    };

    const editDocumentDeclaration = {
        name: "edit_document",
        description:
            "Update an existing document owned by the current user. Persists immediately. Only include fields you want to change.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                documentId: {
                    type: Type.STRING,
                    description: "ObjectId of the document to update",
                },
                title: { type: Type.STRING },
                content: {
                    type: Type.STRING,
                    description:
                        "HTML content (will be sanitized server-side). Use ONLY this tag whitelist: <p>, <div>, <b>, <strong>, <i>, <em>, <u>, <s>, <del>, <ol>, <ul>, <li>, <a>. Emoji (unicode) allowed inline. NO heading tags, NO <br>, NO tables/code/pre/blockquote/images. Use <p> or <div> for structure; bold the first line of a section instead of using a heading.",
                },
                tag: {
                    type: Type.STRING,
                    description: "Category ObjectId",
                },
                active: { type: Type.BOOLEAN },
            },
            required: ["documentId"],
        },
    };

    const summarizeScreenDeclaration = {
        name: "summarize_screen",
        description:
            "Summarize what is on the user's current screen. Behavior by page: 'dashboard' summarizes both tasks and documents; 'tasks' summarizes tasks; 'documents' summarizes documents. The handler fetches the relevant data and produces an HTML summary.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                page: {
                    type: Type.STRING,
                    format: "enum",
                    enum: [
                        "dashboard",
                        "tasks",
                        "documents",
                        "chat",
                        "general",
                    ],
                    description: "Current page the user is viewing",
                },
                focus: {
                    type: Type.STRING,
                    description:
                        "Optional emphasis for the summary, e.g. 'overdue', 'high priority', 'this week'",
                },
                timeRange: {
                    type: Type.STRING,
                    format: "enum",
                    enum: ["today", "this_week", "this_month", "all"],
                },
            },
            required: ["page"],
        },
    };

    return [
        createTasksDeclaration,
        createDocumentDeclaration,
        listTasksDeclaration,
        listDocumentsDeclaration,
        editTaskDeclaration,
        editDocumentDeclaration,
        summarizeScreenDeclaration,
    ];
}

export function createTranscriptsTasksDeclaration(
    Type: any,
    categoryCatalog: { id: string; title: string }[]
) {
    const recurrenceEnum = [
        "none",
        "daily",
        "weekly",
        "monthly",
        "yearly",
    ] as const;

    return {
        name: "create_tasks",
        description: `Extract as many actionable tasks as possible from the transcript. Each task must include a tempId, title, description, priority, and a category chosen from the provided categories catalog. If a dueDate is provided, it must be ISO 8601 including time, aligned to 30-minute intervals (HH:00 or HH:30). Categories available: ${categoryCatalog
            .map((c) => `${c.title} (id: ${c.id})`)
            .join(", ")}.`,
        parameters: {
            type: Type.OBJECT,
            properties: {
                tasks: {
                    type: Type.ARRAY,
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
                            dueDate: {
                                type: Type.STRING,
                                description:
                                    "ISO 8601 with time. Allowed minutes: 00 or 30 only.",
                            },
                            recurrence: {
                                type: Type.STRING,
                                format: "enum",
                                enum: recurrenceEnum as unknown as string[],
                            },
                            category: {
                                type: Type.OBJECT,
                                properties: {
                                    title: { type: Type.STRING },
                                    id: { type: Type.STRING },
                                },
                                required: ["title", "id"],
                            },
                            subtasks: {
                                type: Type.ARRAY,
                                items: {
                                    type: Type.OBJECT,
                                    properties: {
                                        title: { type: Type.STRING },
                                        description: { type: Type.STRING },
                                        done: { type: Type.BOOLEAN },
                                    },
                                    required: ["title"],
                                },
                            },
                        },
                        required: [
                            "tempId",
                            "title",
                            "description",
                            "priority",
                            "category",
                            "dueDate",
                        ],
                    },
                },
            },
            required: ["tasks"],
        },
    };
}
