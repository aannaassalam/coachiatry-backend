export function buildNativeDocumentsJson(docs) {
    console.log(docs);
    return {
        type: "list",
        items: docs.map((d) => ({
            type: "document",
            id: d.id,
            title: d.title,
        })),
    };
}
