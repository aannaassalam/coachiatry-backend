import fs from "fs";
import path from "path";
import { uploadAnyDocument } from "./aws";

/**
 * Generates a PDF from Markdown content in a Node.js environment.
 * @param {string} markdown - The Markdown text to render.
 * @param {string} title - The PDF title.
 * @param {string} category - The category label.
 * @param {string} [outputDir="./"] - Optional directory to save the file.
 * @returns {Promise<string>} The full path to the generated PDF.
 */
export async function generateMarkdownPDF(
    markdown: string,
    title: string,
    category: string
) {
    const { marked } = await import("marked");
    const puppeteer = (await import("puppeteer")).default;

    // 1️⃣ Convert Markdown to HTML
    const htmlContent = marked.parse(markdown);

    // 2️⃣ Resolve logo path (if stored locally)
    const logoPath = path.resolve("../../logo.svg"); // adjust path as needed
    const logoBase64 = fs.existsSync(logoPath)
        ? `data:image/png;base64,${fs.readFileSync(logoPath).toString("base64")}`
        : "";

    // 3️⃣ Build clean HTML
    const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${title}</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
        <style>
          body {
  background-color: #ffffff;
  color: #000000;
  font-family: Inter, Arial, sans-serif;
  line-height: 1.6;
  padding: 0;
}
.pdf-container {
  padding: 5px 20px; /* match original */
  background-color: #ffffff;
}
.pdf-header {
  text-align: center;
  margin-bottom: 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.pdf-header h2 {
  font-size: 30px; /* match original */
}
.pdf-header img {
  height: 50px;
  margin-bottom: 10px;
  align-self: start;
}
.pdf-meta {
  display: flex;
  justify-content: space-between;
  margin-bottom: 15px;
  font-size: 16px;
}
.pdf-content {
  font-size: 16px;
}

        </style>
      </head>
      <body>
        <div class="pdf-container">
          <div class="pdf-header">
            ${logoBase64 ? `<img src="${logoBase64}" alt="Logo" />` : ""}
            <h2>${title}</h2>
          </div>
          <div class="pdf-meta">
            <span><strong>Category:</strong> ${category}</span>
            <span><strong>Date:</strong> ${new Date().toLocaleDateString()}</span>
          </div>
          <div class="pdf-content">${htmlContent}</div>
        </div>
      </body>
    </html>
  `;

    // 4️⃣ Launch Puppeteer to render and export PDF
    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox"],
    });
    const page = await browser.newPage();

    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: {
            top: "20mm",
            bottom: "20mm",
            left: "15mm",
            right: "15mm",
        },
    });

    await browser.close();

    const url = await uploadAnyDocument(
        pdfBuffer,
        `${title.trim().replace(/\s+/g, "_")}.pdf`
    );

    console.log(`✅ PDF saved`);
    return url;
}
