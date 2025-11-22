export function buildJsonText(text) {
    return {
        type: "view",
        children: [{ type: "text", text }],
    };
}
