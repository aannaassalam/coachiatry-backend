import DOMPurify from "isomorphic-dompurify";

export const sanitizeHtml = (content: string) =>
    DOMPurify.sanitize(content, {
        ALLOWED_TAGS: [
            "p",
            "h2",
            "h3",
            "b",
            "i",
            "ol",
            "li",
            "a",
            "div",
            "br",
            "strong",
            "em",
            "code",
            "pre",
        ],
        ALLOWED_ATTR: ["href", "class"],
    });

export const toHtmlParagraph = (text: string) =>
    `<div class="ai-text"><p>${sanitizeHtml(text)}</p></div>`;
