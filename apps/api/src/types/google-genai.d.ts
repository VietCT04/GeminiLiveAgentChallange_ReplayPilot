declare module '@google/genai' {
  export class GoogleGenAI {
    constructor(config: { apiKey: string });
    models: {
      generateContent(input: {
        model: string;
        contents: Array<
          | {
              text: string;
            }
          | {
              inlineData: {
                mimeType: string;
                data: string;
              };
            }
        >;
      }): Promise<{
        text?: string;
      }>;
    };
  }
}
