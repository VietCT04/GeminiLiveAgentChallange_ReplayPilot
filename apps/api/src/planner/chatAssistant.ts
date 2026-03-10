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
  workflowPhase: z.enum(['CHAT', 'DISCOVERY', 'PROPOSAL']),
  proposalGoal: z.string().trim().min(1).max(500).optional(),
  proposalSummary: z.string().trim().min(1).max(800).optional(),
});

export type ChatReply = z.infer<typeof ChatReplySchema>;

const ChatReplyResponseSchema = {
  type: 'OBJECT',
  properties: {
    assistantMessage: { type: 'STRING' },
    workflowPhase: {
      type: 'STRING',
      enum: ['CHAT', 'DISCOVERY', 'PROPOSAL'],
    },
    proposalGoal: { type: 'STRING' },
    proposalSummary: { type: 'STRING' },
  },
  required: ['assistantMessage', 'workflowPhase'],
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
    'Follow this control flow strictly:',
    'Phase CHAT: normal conversation for non-automation requests.',
    'Phase DISCOVERY: user wants automation but details are incomplete; ask concise follow-up questions.',
    'Phase PROPOSAL: only when details are sufficient, provide a concise workflow proposal.',
    'A sufficient proposal includes all required fields:',
    '- task to automate',
    '- target app/site or URL',
    '- trigger/start condition',
    '- success criteria',
    '- sensitive/login/approval notes',
    'If user only says "I want a workflow" or similar, do NOT jump to proposal; stay DISCOVERY.',
    'If required fields are incomplete, stay DISCOVERY and ask only for the missing fields.',
    'If required fields are complete and user asks to proceed (e.g. "build the workflow", "build now", "yes proceed"), return PROPOSAL immediately.',
    'When in PROPOSAL, assistantMessage must include a compact proposal summary and mention that user can click Generate Workflow Plan.',
    'Set proposalGoal only when workflowPhase=PROPOSAL.',
    'Set proposalSummary only when workflowPhase=PROPOSAL.',
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
