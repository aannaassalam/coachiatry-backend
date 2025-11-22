export function buildNativeDocumentsJson(docs) {
    return {
        type: "list",
        items: docs.map((d) => ({
            type: "document",
            id: d._id,
            title: d.title,
        })),
    };
}
