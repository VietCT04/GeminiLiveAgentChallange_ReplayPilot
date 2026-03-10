import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { withGeminiRetry } from '../lib/geminiRetry';

const HIGH_LEVEL_PLAN_MODEL_NAME =
  process.env.GEMINI_HIGH_LEVEL_PLAN_MODEL ?? 'gemini-2.5-flash';

const HighLevelPlanSchema = z.object({
  summary: z.string().min(1),
  steps: z.array(z.string().min(1).max(200)).min(1),
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
    'You are ReplayPilot workflow planner.',
    'Your job is to convert a confirmed workflow goal into an explicit browser execution plan for a computer-use agent.',
    '',
    'The plan must be concrete, UI-oriented, and executable step by step.',
    'Return steps as an array of strings only.',
    '',
    'Write steps the way an operator would perform them in a browser:',
    '- open a specific website or page',
    '- click a visible button, tab, or menu',
    '- type a specific value into a named field',
    '- select an option from a visible dropdown',
    '- verify that the page changed or the expected content appears',
    '',
    'Do NOT write vague steps like:',
    '- access the interface',
    '- specify client details',
    '- populate the form',
    '- verify everything',
    '',
    'Instead, write concrete actions such as:',
    '- Go to https://app.example.com/invoices',
    '- Click "Create Invoice"',
    '- In the "Client Name" field, type "Acme Pte Ltd"',
    '- In the "Service Description" field, type "Consulting services for February 2026"',
    '- In the "Amount" field, type "1200"',
    '- Click "Submit"',
    '',
    'Planning rules:',
    '- Prefer one clear user-visible action per step.',
    '- Mention the target page, button, field label, or visible text whenever possible.',
    '- If a value is known from the user goal, include it explicitly.',
    '- If a value is unknown, use a placeholder and mention it clearly.',
    '- If login is required but credentials are not provided, include a login step and mark it as requiring user action or confirmation.',
    '- The final submit/approve/send action should usually be its own sensitive step.',
    '- Keep each step short but specific.',
    '',
    'Output JSON only:',
    '{ "summary": string, "steps": string[] }',
    '',
    `Confirmed workflow goal: ${goal}`,
  ].join('\n');
};

export const generateHighLevelPlan = async (
  goal: string,
): Promise<HighLevelPlan> => {
  const ai = getClient();
  const response = await withGeminiRetry(
    async () =>
      ai.models.generateContent({
        model: HIGH_LEVEL_PLAN_MODEL_NAME,
        contents: [{ text: buildHighLevelPlanPrompt(goal) }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: HighLevelPlanResponseSchema,
        },
      }),
    { label: 'high-level-plan' },
  );
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
