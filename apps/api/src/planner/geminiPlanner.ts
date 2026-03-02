import { ActionSchema, type Action, type StepRecord } from '@replaypilot/shared';
import { GoogleGenAI } from '@google/genai';

const MODEL_NAME = 'gemini-2.5-flash';
const HISTORY_WINDOW = 6;

type PlannerRequestLog = {
  model: string;
  goal: string;
  history: StepRecord[];
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
  parsedAction?: Action;
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

const buildPrompt = (goal: string, history: StepRecord[]): string => {
  return [
    'You are a browser action planner for a coordinate-based UI agent.',
    'You must produce exactly one next action as strict JSON matching this shape:',
    '{"type":"navigate","url":"https://..."}',
    '{"type":"click","x":0,"y":0,"button":"left","clicks":1}',
    '{"type":"type","text":"...","x":0,"y":0,"submit":false}',
    '{"type":"scroll","deltaY":600}',
    '{"type":"wait","ms":500}',
    '{"type":"done","reason":"..."}',
    'Return ONLY raw JSON. No markdown. No code fences. No commentary.',
    'Use safe, minimal, non-destructive actions. Prefer short waits and the fewest steps needed.',
    'Use only actions that can be executed from the current screenshot.',
    'If the goal already appears completed, return {"type":"done","reason":"..."}',
    `Goal: ${goal}`,
    `Recent history (${history.length}): ${JSON.stringify(history)}`,
  ].join('\n');
};

export const planNextAction = async (
  goal: string,
  screenshotBytes: Buffer,
  history: StepRecord[],
): Promise<Action> => {
  const result = await planNextActionDetailed(goal, screenshotBytes, history);
  return result.action;
};

export const planNextActionDetailed = async (
  goal: string,
  screenshotBytes: Buffer,
  history: StepRecord[],
): Promise<{ action: Action; debug: PlannerDebugPayload }> => {
  const recentHistory = history.slice(-HISTORY_WINDOW);
  const prompt = buildPrompt(goal, recentHistory);
  const base64Image = screenshotBytes.toString('base64');
  const requestLog: PlannerRequestLog = {
    model: MODEL_NAME,
    goal,
    history: recentHistory,
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

  let action: Action;

  try {
    action = ActionSchema.parse(parsedJson);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown schema error';
    throw new Error(`Gemini planner returned invalid Action JSON: ${reason}`);
  }

  responseLog.parsedAction = action;

  return {
    action,
    debug: {
      request: requestLog,
      response: responseLog,
    },
  };
};
