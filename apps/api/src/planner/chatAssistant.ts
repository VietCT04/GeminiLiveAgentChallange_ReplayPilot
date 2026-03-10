import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

const CHAT_MODEL_NAME =
  process.env.GEMINI_CHAT_MODEL ??
  process.env.GEMINI_HIGH_LEVEL_PLAN_MODEL ??
  'gemini-2.5-flash';

const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string().trim().min(1).max(2000),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

const ChatReplySchema = z.object({
  assistantMessage: z.string().trim().min(1).max(2000),
  workflowIntent: z.boolean(),
  workflowGoal: z.string().trim().min(1).max(500).optional(),
  workflowReason: z.string().trim().min(1).max(500).optional(),
});

export type ChatReply = z.infer<typeof ChatReplySchema>;

const ChatReplyResponseSchema = {
  type: 'OBJECT',
  properties: {
    assistantMessage: { type: 'STRING' },
    workflowIntent: { type: 'BOOLEAN' },
    workflowGoal: { type: 'STRING' },
    workflowReason: { type: 'STRING' },
  },
  required: ['assistantMessage', 'workflowIntent'],
} as const;

const getClient = (): GoogleGenAI => {
  const apiKey = process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY is required for chat assistant');
  }

  return new GoogleGenAI({ apiKey });
};

const buildChatPrompt = (message: string, history: ChatMessage[]): string => {
  const compactHistory = history
    .slice(-8)
    .map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`)
    .join('\n');

  return [
    'You are ReplayPilot chat assistant.',
    'Respond conversationally and helpfully to the user message.',
    'Also classify if user currently has workflow intent.',
    'workflowIntent=true only when user asks to build/automate a multi-step browser workflow.',
    'For casual Q&A (weather, definitions, chit-chat), workflowIntent=false.',
    'If workflowIntent=true, include a concise workflowGoal and workflowReason.',
    compactHistory ? `Conversation history:\n${compactHistory}` : 'Conversation history: none',
    `Latest user message: ${message}`,
    'Return JSON only.',
  ].join('\n');
};

export const generateChatReply = async (
  message: string,
  history: ChatMessage[],
): Promise<ChatReply> => {
  const normalizedHistory = history.map((entry) => ChatMessageSchema.parse(entry));
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: CHAT_MODEL_NAME,
    contents: [{ text: buildChatPrompt(message, normalizedHistory) }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: ChatReplyResponseSchema,
    },
  });

  const rawText = response.text?.trim() ?? '';

  if (!rawText) {
    throw new Error('Gemini chat assistant returned empty output');
  }

  return ChatReplySchema.parse(JSON.parse(rawText));
};
