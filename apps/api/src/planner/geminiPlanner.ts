import { ActionSchema, type Action, type StepRecord } from '@replaypilot/shared';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

const MODEL_NAME = 'gemini-2.5-flash';
const HISTORY_WINDOW = 6;

const PlannerOutputSchema = z.object({
  summary: z.string().min(1).max(160),
  action: ActionSchema,
});

type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export type PlannerViewport = {
  width: number;
  height: number;
};

type PlannerRequestLog = {
  model: string;
  goal: string;
  history: StepRecord[];
  viewport: PlannerViewport;
  prompt: string;
  contents: Array<
    | {
        text: string;
      }
    | {
        inlineData: {
          mimeType: 'image/png';
          data: string;
        };
      }
  >;
};

type PlannerResponseLog = {
  rawText: string;
  parsedOutput?: PlannerOutput;
};

export type PlannerDebugPayload = {
  request: PlannerRequestLog;
  response: PlannerResponseLog;
};

const getClient = (): GoogleGenAI => {
  const apiKey = process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY is required for Gemini planning');
  }

  return new GoogleGenAI({ apiKey });
};

const buildPrompt = (
  goal: string,
  history: StepRecord[],
  viewport: PlannerViewport,
): string => {
  const maxX = viewport.width - 1;
  const maxY = viewport.height - 1;

  return [
    'You are a browser action planner for a coordinate-based UI agent.',
    'You must produce exactly one JSON object with this exact shape:',
    '{"summary":"short step intent","action":{"type":"navigate","url":"https://..."}}',
    '{"summary":"short step intent","action":{"type":"click","x":0,"y":0,"button":"left","clicks":1}}',
    '{"summary":"short step intent","action":{"type":"type","text":"...","x":0,"y":0,"submit":false}}',
    '{"summary":"short step intent","action":{"type":"scroll","deltaY":600}}',
    '{"summary":"short step intent","action":{"type":"wait","ms":500}}',
    '{"summary":"short step intent","action":{"type":"done","reason":"..."}}',
    'Return ONLY raw JSON. No markdown. No code fences. No commentary.',
    'The "summary" must be a short plain-English description of what this step is trying to do.',
    'Use safe, minimal, non-destructive actions. Prefer short waits and the fewest steps needed.',
    'Use only actions that can be executed from the current screenshot.',
    'Coordinate system rules for x,y:',
    `- The screenshot viewport is width=${viewport.width}, height=${viewport.height}.`,
    `- Origin is top-left of the webpage viewport: (0,0).`,
    `- x increases to the right and must be an integer between 0 and ${maxX}.`,
    `- y increases downward and must be an integer between 0 and ${maxY}.`,
    '- For click or type with x,y, choose the center of the visible clickable target.',
    '- Never output off-screen coordinates.',
    '- If the target is uncertain or not clearly clickable, prefer wait or scroll instead of guessing.',
    'If the goal already appears completed, return {"summary":"...","action":{"type":"done","reason":"..."}}',
    `Goal: ${goal}`,
    `Recent history (${history.length}): ${JSON.stringify(history)}`,
  ].join('\n');
};

export const planNextAction = async (
  goal: string,
  screenshotBytes: Buffer,
  history: StepRecord[],
  viewport: PlannerViewport,
): Promise<Action> => {
  const result = await planNextActionDetailed(goal, screenshotBytes, history, viewport);
  return result.action;
};

export const planNextActionDetailed = async (
  goal: string,
  screenshotBytes: Buffer,
  history: StepRecord[],
  viewport: PlannerViewport,
): Promise<{ action: Action; summary: string; debug: PlannerDebugPayload }> => {
  const recentHistory = history.slice(-HISTORY_WINDOW);
  const prompt = buildPrompt(goal, recentHistory, viewport);
  const base64Image = screenshotBytes.toString('base64');
  const requestLog: PlannerRequestLog = {
    model: MODEL_NAME,
    goal,
    history: recentHistory,
    viewport,
    prompt,
    contents: [
      { text: prompt },
      {
        inlineData: {
          mimeType: 'image/png',
          data: base64Image,
        },
      },
    ],
  };

  const ai = getClient();
  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: requestLog.contents,
  });

  const rawText = response.text?.trim() ?? '';
  const responseLog: PlannerResponseLog = {
    rawText,
  };

  if (!rawText) {
    throw new Error('Gemini planner returned an empty response');
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    throw new Error(`Gemini planner returned non-JSON output: ${rawText}`);
  }

  let parsedOutput: PlannerOutput;

  try {
    parsedOutput = PlannerOutputSchema.parse(parsedJson);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown schema error';
    throw new Error(`Gemini planner returned invalid planner JSON: ${reason}`);
  }

  responseLog.parsedOutput = parsedOutput;

  return {
    action: parsedOutput.action,
    summary: parsedOutput.summary,
    debug: {
      request: requestLog,
      response: responseLog,
    },
  };
};
