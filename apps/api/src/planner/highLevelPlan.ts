import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

const HIGH_LEVEL_PLAN_MODEL_NAME =
  process.env.GEMINI_HIGH_LEVEL_PLAN_MODEL ?? 'gemini-2.5-flash';

const HighLevelPlanSchema = z.object({
  summary: z.string().min(1).max(200),
  steps: z.array(z.string().min(1).max(200)).min(1).max(12),
});

export type HighLevelPlan = z.infer<typeof HighLevelPlanSchema>;

const HighLevelPlanResponseSchema = {
  type: 'OBJECT',
  properties: {
    summary: {
      type: 'STRING',
    },
    steps: {
      type: 'ARRAY',
      items: {
        type: 'STRING',
      },
    },
  },
  required: ['summary', 'steps'],
} as const;

const getClient = (): GoogleGenAI => {
  const apiKey = process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY is required for Gemini planning');
  }

  return new GoogleGenAI({ apiKey });
};

const buildHighLevelPlanPrompt = (goal: string): string => {
  return [
    'Draft a high-level browser automation plan before execution starts.',
    'Keep steps human-editable and focused on visible milestones.',
    'Use 3 to 7 concise steps.',
    'Do not mention internal tools, coordinates, or pixels.',
    `Goal: ${goal}`,
  ].join('\n');
};

export const generateHighLevelPlan = async (
  goal: string,
): Promise<HighLevelPlan> => {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: HIGH_LEVEL_PLAN_MODEL_NAME,
    contents: [{ text: buildHighLevelPlanPrompt(goal) }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: HighLevelPlanResponseSchema,
    },
  });
  const rawText = response.text?.trim() ?? '';

  if (!rawText) {
    throw new Error('Gemini high-level plan returned empty output');
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    throw new Error(`Gemini high-level plan returned non-JSON output: ${rawText}`);
  }

  try {
    return HighLevelPlanSchema.parse(parsedJson);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown schema error';
    throw new Error(`Gemini high-level plan returned invalid JSON: ${reason}`);
  }
};
