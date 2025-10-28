import { sanitizeHtml } from "../utils/html";

export function buildTasksHtml(taskList: any[]) {
    return taskList.length
        ? `<div class="ai-results">${taskList
              .map(
                  (t) =>
                      `<div class="ai-item"><a href="${t.url}">${sanitizeHtml(t.title)}</a> — ${sanitizeHtml(
                          t.priority || ""
                      )} ${t.category ? `• ${sanitizeHtml(t.category)}` : ""} ${
                          t.dueDate
                              ? `• due ${new Date(t.dueDate).toDateString()}`
                              : ""
                      }</div>`
              )
              .join("")}</div>`
        : `<p>No matching tasks found.</p>`;
}

export function buildDocumentsHtml(docList: any[]) {
    return docList.length
        ? `<div class="ai-results">${docList
              .map(
                  (d) =>
                      `<div class="ai-item"><a href="${d.url}">${sanitizeHtml(d.title)}</a> ${d.tag ? `— ${sanitizeHtml(d.tag)}` : ""}</div>`
              )
              .join("")}</div>`
        : `<p>No matching documents found.</p>`;
}

export function renderTranscriptForPrompt(doc: any, maxChars = 18000) {
    const lines = (doc.transcriptions || []).map((t: any) => {
        const ts = new Date(t.timestamp).toISOString();
        return `[${ts}] ${t.name}: ${t.text}`;
    });
    const text = lines.join("\n");
    // The model rules say no \n in the HTML output, but prompts can contain \n safely.
    return text.length > maxChars ? text.slice(0, maxChars) : text;
}

// DueDate normalizer: snap minutes to 00 or 30, zero seconds, ISO output
export function normalizeDueDate(dueDate?: string): string | null {
    if (!dueDate) return null;
    const d = new Date(dueDate);
    if (isNaN(d.getTime())) return null;
    const minutes = d.getUTCMinutes();
    if (minutes !== 0 && minutes !== 30) {
        const rounded = minutes < 15 ? 0 : minutes < 45 ? 30 : 0;
        if (rounded === 0 && minutes >= 45) d.setUTCHours(d.getUTCHours() + 1);
        d.setUTCMinutes(rounded);
    }
    d.setUTCSeconds(0, 0);
    return d.toISOString();
}

// Enforce HTML rules post-process: replace <ul> with <ol>, wrap bare <li>, replace \n with <br/>
export function enforceHtmlRules(html: string): string {
    let out = html || "";
    // Replace UL with OL
    out = out.replace(/<\/?ul>/gi, (m) => m.replace(/ul/i, "ol"));
    // Wrap bare <li> that are not inside an <ol> (simple heuristic)
    const hasOl = /<ol[\s>][\s\S]*<\/ol>/i.test(out);
    if (!hasOl && /<li[\s>]/i.test(out)) {
        out = `<ol>${out}</ol>`;
    }
    // Replace newlines with <br/>
    out = out.replace(/\n/g, "<br/>");
    return out;
}

// Build category catalog for the model and provide mapping aids
export function buildCategoryCatalog(categories: any[]) {
    return categories.map((c) => ({
        id: String(c._id),
        title: c.title || c.name || "Untitled",
    }));
}

// Validate or map model category -> existing categories
export function coerceCategory(
    modelCat: any,
    catalog: { id: string; title: string }[],
    fallback: { id: string; title: string }
) {
    if (!modelCat) return fallback;
    const id = String(modelCat.id || "");
    const title = String(modelCat.title || "")
        .toLowerCase()
        .trim();

    // Exact ID match
    const byId = catalog.find((c) => c.id === id);
    if (byId) return { id: byId.id, title: byId.title };

    // Case-insensitive title match
    const byTitle = catalog.find(
        (c) => (c.title || "").toLowerCase().trim() === title
    );
    if (byTitle) return { id: byTitle.id, title: byTitle.title };

    // Fallback
    return fallback;
}
