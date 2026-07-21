export const getGeminiClient = async () => {
    const { GoogleGenAI, Type } = await import("@google/genai");

    return {
        ai: new GoogleGenAI({
            apiKey: process.env.GEMINI_API_KEY!,
        }),
        Type,
    };
};
