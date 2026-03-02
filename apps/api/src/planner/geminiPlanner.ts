import { ActionSchema, type Action, type StepRecord } from '@replaypilot/shared';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

const FLASH_MODEL_NAME = 'gemini-3-flash';
const PRO_MODEL_NAME = 'gemini-3-pro';
const HISTORY_WINDOW = 6;
const LOW_CONFIDENCE_THRESHOLD = 3;

const PlannerOutputSchema = z.object({
  summary: z.string().min(1).max(160),
  action: ActionSchema,
});

type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export type PlannerViewport = {
  width: number;
  height: number;
};

export type PlannerContext = {
  verifierLowConfidenceStreak?: number;
};

type PlannerRequestLog = {
  model: string;
  modelReason: string;
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
  retryWithPro?: boolean;
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

const countTrailingIdenticalActions = (history: StepRecord[]): number => {
  if (history.length === 0) {
    return 0;
  }

  const lastActionKey = JSON.stringify(history[history.length - 1]?.action);
  let count = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];

    if (!entry || JSON.stringify(entry.action) !== lastActionKey) {
      break;
    }

    count += 1;
  }

  return count;
};

const isCriticalStep = (output: PlannerOutput): boolean => {
  const summary = output.summary.toLowerCase();

  if (
    output.action.type === 'type' &&
    output.action.submit === true
  ) {
    return true;
  }

  if (output.action.type === 'done') {
    return false;
  }

  return (
    summary.includes('like') ||
    summary.includes('submit') ||
    summary.includes('confirm') ||
    summary.includes('place order')
  );
};

const wouldCreateThreepeat = (
  history: StepRecord[],
  nextAction: Action,
): boolean => {
  if (history.length < 2) {
    return false;
  }

  const nextActionKey = JSON.stringify(nextAction);
  const lastTwo = history.slice(-2).map((entry) => JSON.stringify(entry.action));

  return lastTwo.every((entry) => entry === nextActionKey);
};

const selectInitialModel = (
  history: StepRecord[],
  context: PlannerContext,
): { model: string; reason: string } => {
  const repeatedCount = countTrailingIdenticalActions(history);

  if (repeatedCount >= 2) {
    return {
      model: PRO_MODEL_NAME,
      reason: 'recent repeated action pattern',
    };
  }

  if ((context.verifierLowConfidenceStreak ?? 0) >= LOW_CONFIDENCE_THRESHOLD) {
    return {
      model: PRO_MODEL_NAME,
      reason: 'verifier confidence remained low',
    };
  }

  return {
    model: FLASH_MODEL_NAME,
    reason: 'default fast planning',
  };
};

const tryRepairPlannerJson = (rawText: string): unknown | null => {
  const summaryKey = '"summary":"';
  const actionKey = '","action":';
  const summaryStart = rawText.indexOf(summaryKey);
  const actionStart = rawText.indexOf(actionKey);

  if (summaryStart === -1 || actionStart === -1 || actionStart <= summaryStart) {
    return null;
  }

  const contentStart = summaryStart + summaryKey.length;
  const summaryValue = rawText.slice(contentStart, actionStart);
  const sanitizedSummary = summaryValue.replace(/"/g, "'");
  const repaired =
    rawText.slice(0, contentStart) +
    sanitizedSummary +
    rawText.slice(actionStart);

  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
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
    'Do not use double quotes inside the summary string. Paraphrase labels instead of quoting UI text.',
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
  context: PlannerContext = {},
): Promise<Action> => {
  const result = await planNextActionDetailed(
    goal,
    screenshotBytes,
    history,
    viewport,
    context,
  );
  return result.action;
};

const generatePlannerOutput = async (
  ai: GoogleGenAI,
  model: string,
  requestLog: PlannerRequestLog,
): Promise<PlannerResponseLog> => {
  const response = await ai.models.generateContent({
    model,
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
    const repaired = tryRepairPlannerJson(rawText);

    if (repaired === null) {
      throw new Error(`Gemini planner returned non-JSON output: ${rawText}`);
    }

    parsedJson = repaired;
  }

  try {
    responseLog.parsedOutput = PlannerOutputSchema.parse(parsedJson);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown schema error';
    throw new Error(`Gemini planner returned invalid planner JSON: ${reason}`);
  }

  return responseLog;
};

export const planNextActionDetailed = async (
  goal: string,
  screenshotBytes: Buffer,
  history: StepRecord[],
  viewport: PlannerViewport,
  context: PlannerContext = {},
): Promise<{ action: Action; summary: string; debug: PlannerDebugPayload }> => {
  const recentHistory = history.slice(-HISTORY_WINDOW);
  const prompt = buildPrompt(goal, recentHistory, viewport);
  const base64Image = screenshotBytes.toString('base64');
  const initialModel = selectInitialModel(recentHistory, context);
  const requestLog: PlannerRequestLog = {
    model: initialModel.model,
    modelReason: initialModel.reason,
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
  let responseLog = await generatePlannerOutput(ai, initialModel.model, requestLog);

  if (
    initialModel.model === FLASH_MODEL_NAME &&
    responseLog.parsedOutput &&
    (isCriticalStep(responseLog.parsedOutput) ||
      wouldCreateThreepeat(recentHistory, responseLog.parsedOutput.action))
  ) {
    requestLog.model = PRO_MODEL_NAME;
    requestLog.modelReason = isCriticalStep(responseLog.parsedOutput)
      ? 'critical step escalation'
      : 'same action would repeat three times';
    responseLog = await generatePlannerOutput(ai, PRO_MODEL_NAME, requestLog);
    responseLog.retryWithPro = true;
  }

  const parsedOutput = responseLog.parsedOutput;

  if (!parsedOutput) {
    throw new Error('Gemini planner did not return parsed output');
  }

  return {
    action: parsedOutput.action,
    summary: parsedOutput.summary,
    debug: {
      request: requestLog,
      response: responseLog,
    },
  };
};
