import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { withGeminiRetry } from '../lib/geminiRetry';

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
  proposalSummary: z.string().trim().min(1).optional(),
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
    'You are ReplayPilot, a chat-first assistant that helps users automate browser workflows.',
    '',
    'Your job is to decide the current workflow stage and respond naturally.',
    '',
    'Stages:',
    '- CHAT: regular conversation or questions not yet about building a workflow.',
    '- DISCOVERY: the user wants automation, but important workflow details are still missing.',
    '- PROPOSAL: there is enough information to draft a first workflow proposal.',
    '',
    'Move to DISCOVERY when the user expresses interest in automation or workflow building.',
    'Move to PROPOSAL only when the workflow is concrete enough for a first draft.',
    '',
    'To be ready for PROPOSAL, try to understand:',
    '- what task to automate',
    '- where it happens (app, site, or URL)',
    '- what successful completion looks like',
    '- important input data or fields that must be filled, if relevant',
    '',
    'Optional details:',
    '- trigger or start condition',
    '- login requirements',
    '- approval or sensitive actions',
    '',
    'Behavior rules:',
    '- Keep the assistantMessage natural and conversational.',
    '- In DISCOVERY, ask only 1 to 3 focused follow-up questions.',
    '- Do not dump a long questionnaire.',
    '- If the user only says they want a workflow, stay in DISCOVERY.',
    '- If enough details are known, switch to PROPOSAL.',
    '- In PROPOSAL, give a short summary of the workflow and mention that the user can click Generate Workflow Plan.',
    '',
    'Output JSON only with these fields:',
    '- assistantMessage: string',
    '- workflowPhase: "CHAT" | "DISCOVERY" | "PROPOSAL"',
    '- proposalGoal?: string',
    '- proposalSummary?: string',
    '',
    'Set proposalGoal and proposalSummary only when workflowPhase is PROPOSAL.',
    compactHistory ? `Conversation history:\n${compactHistory}` : 'Conversation history: none',
    `Latest user message: ${message}`,
    'Return JSON only.'
  ].join('\\n');
};

export const generateChatReply = async (
  message: string,
  history: ChatMessage[],
): Promise<ChatReply> => {
  const normalizedHistory = history.map((entry) => ChatMessageSchema.parse(entry));
  const ai = getClient();
  const response = await withGeminiRetry(
    async () =>
      ai.models.generateContent({
        model: CHAT_MODEL_NAME,
        contents: [{ text: buildChatPrompt(message, normalizedHistory) }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: ChatReplyResponseSchema,
        },
      }),
    { label: 'chat-assistant' },
  );

  const rawText = response.text?.trim() ?? '';

  if (!rawText) {
    throw new Error('Gemini chat assistant returned empty output');
  }

  return ChatReplySchema.parse(JSON.parse(rawText));
};
