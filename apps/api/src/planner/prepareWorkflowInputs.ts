import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { withGeminiRetry } from '../lib/geminiRetry';

const INPUT_PREP_MODEL_NAME =
  process.env.GEMINI_WORKFLOW_INPUT_MODEL ??
  process.env.GEMINI_HIGH_LEVEL_PLAN_MODEL ??
  'gemini-2.5-flash';

const HistoryEntrySchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string().trim().min(1),
});

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

const PreparedInputSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.toLowerCase().replace(/[^a-z0-9_]+/g, '_')),
  label: z.string().trim().min(1),
  required: z.boolean(),
  value: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).optional(),
});

const PrepareWorkflowInputsSchema = z.object({
  inputs: z.array(PreparedInputSchema),
});

const PrepareWorkflowInputsResponseSchema = {
  type: 'OBJECT',
  properties: {
    inputs: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          key: { type: 'STRING' },
          label: { type: 'STRING' },
          required: { type: 'BOOLEAN' },
          value: { type: 'STRING' },
          reason: { type: 'STRING' },
        },
        required: ['key', 'label', 'required'],
      },
    },
  },
  required: ['inputs'],
} as const;

export type PreparedWorkflowInput = z.infer<typeof PreparedInputSchema>;

export type PreparedWorkflowInputs = {
  inputs: PreparedWorkflowInput[];
  inputMap: Record<string, string>;
  missingRequiredKeys: string[];
};

const getClient = (): GoogleGenAI => {
  const apiKey = process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY is required for workflow input preparation');
  }

  return new GoogleGenAI({ apiKey });
};

const buildPrompt = (goal: string, history: HistoryEntry[]): string => {
  const historyText = history
    .slice(-20)
    .map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`)
    .join('\n');

  return [
    'You are ReplayPilot workflow input preparation service.',
    'Extract workflow inputs required to execute the goal.',
    'Fill values only if explicitly present in the conversation history.',
    '',
    'Rules:',
    '- Return JSON only.',
    '- key must be snake_case and stable (examples: username, password, invoice_number, vendor_name, invoice_amount).',
    '- Include required=true for values needed to complete the workflow.',
    '- If value is known, include value.',
    '- If value is unknown, omit value and include a short reason.',
    '- Do not invent values.',
    '- Avoid duplicates. Prefer one canonical key per concept.',
    '',
    'Output JSON shape:',
    '{"inputs":[{"key":"string","label":"string","required":true|false,"value":"string?","reason":"string?"}]}',
    '',
    `Workflow goal: ${goal}`,
    historyText ? `Conversation history:\n${historyText}` : 'Conversation history: none',
  ].join('\n');
};

const dedupeInputs = (inputs: PreparedWorkflowInput[]): PreparedWorkflowInput[] => {
  const deduped = new Map<string, PreparedWorkflowInput>();

  for (const item of inputs) {
    const existing = deduped.get(item.key);

    if (!existing) {
      deduped.set(item.key, item);
      continue;
    }

    if (!existing.value && item.value) {
      deduped.set(item.key, item);
      continue;
    }

    if (!existing.required && item.required) {
      deduped.set(item.key, item);
    }
  }

  return Array.from(deduped.values());
};

export const prepareWorkflowInputs = async (
  goal: string,
  history: HistoryEntry[],
): Promise<PreparedWorkflowInputs> => {
  const normalizedHistory = history.map((entry) => HistoryEntrySchema.parse(entry));
  const ai = getClient();
  const response = await withGeminiRetry(
    async () =>
      ai.models.generateContent({
        model: INPUT_PREP_MODEL_NAME,
        contents: [{ text: buildPrompt(goal, normalizedHistory) }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: PrepareWorkflowInputsResponseSchema,
        },
      }),
    { label: 'prepare-workflow-inputs' },
  );

  const rawText = response.text?.trim() ?? '';

  if (!rawText) {
    throw new Error('Workflow input preparation returned empty output');
  }

  const parsed = PrepareWorkflowInputsSchema.parse(JSON.parse(rawText));
  const inputs = dedupeInputs(parsed.inputs);
  const inputMap = Object.fromEntries(
    inputs
      .filter((input) => typeof input.value === 'string' && input.value.length > 0)
      .map((input) => [input.key, input.value as string]),
  );
  const missingRequiredKeys = inputs
    .filter((input) => input.required && !input.value)
    .map((input) => input.key);

  return {
    inputs,
    inputMap,
    missingRequiredKeys,
  };
};
