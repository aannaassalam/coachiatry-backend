export function buildNativeTasksJson(tasks) {
    console.log(tasks);
    return {
        type: "list",
        items: tasks.map((t) => ({
            type: "task",
            id: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority,
        })),
    };
}
