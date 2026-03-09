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
              role: string;
              parts: Array<
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
            }
          | {
              inlineData: {
                mimeType: string;
                data: string;
              };
            }
        >;
        tools?: Array<{
          computerUse: {
            environment: string;
          };
        }>;
        config?: {
          responseMimeType?: string;
          responseSchema?: unknown;
          tools?: Array<{
            computerUse: {
              environment: string;
            };
          }>;
        };
      }): Promise<{
        text?: string;
      }>;
    };
  }
}
