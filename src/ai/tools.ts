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
            "Generate a minimum of 10 actionable tasks with optional subtasks, dueDate (ISO 8601), priority, recurrence, and category (id must exist). If dueDate is provided, the time must be aligned to 30-minute intervals only (e.g., 09:00, 09:30, 14:00, 14:30). Never generate arbitrary minute values.",
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
            "Generate a document with HTML content and a valid tag category. Content must be sanitized on server.",
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
            "Query tasks or documents with filters including date, priority, status, tag, and limit.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                type: {
                    type: Type.STRING,
                    format: "enum",
                    enum: ["tasks", "documents"],
                },
                filters: {
                    type: Type.OBJECT,
                    properties: {
                        date: { type: Type.STRING },
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

    return [
        createTasksDeclaration,
        createDocumentDeclaration,
        fetchDataDeclaration,
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
