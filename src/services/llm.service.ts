import OpenAI from "openai";

export const openai = new OpenAI({
    apiKey: process.env["OPENAI_API_KEY"], // This is the default and can be omitted
});

export const getGeminiClient = async () => {
    const { GoogleGenAI } = await import("@google/genai");

    return new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY!,
    });
};
