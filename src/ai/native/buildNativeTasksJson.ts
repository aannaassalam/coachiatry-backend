export function buildNativeTasksJson(tasks) {
    return {
        type: "list",
        items: tasks.map((t) => ({
            type: "task",
            id: t._id,
            title: t.title,
            status: t.status,
            priority: t.priority,
        })),
    };
}
