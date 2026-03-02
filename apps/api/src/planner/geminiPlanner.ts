import { ActionSchema, type Action, type StepRecord } from '@replaypilot/shared';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

const COMPUTER_USE_MODEL_NAME =
  process.env.GEMINI_COMPUTER_USE_MODEL ??
  'gemini-2.5-computer-use-preview-10-2025';
const FLASH_MODEL_NAME = COMPUTER_USE_MODEL_NAME;
const PRO_MODEL_NAME = COMPUTER_USE_MODEL_NAME;
const HISTORY_WINDOW = 6;
const LOW_CONFIDENCE_THRESHOLD = 3;

const PlannerOutputSchema = z.object({
  summary: z.string().min(1).max(160),
  action: ActionSchema,
});

type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

type PlannerFunctionCall = {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
};

type PlannerSdkResponse = {
  text?: string;
  functionCalls?: PlannerFunctionCall[] | (() => PlannerFunctionCall[] | undefined);
  candidates?: Array<{
    content?: {
      parts?: Array<{
        functionCall?: PlannerFunctionCall;
      }>;
    };
  }>;
};

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
  config: {
    tools: Array<{
      computerUse: {
        environment: 'ENVIRONMENT_BROWSER';
      };
    }>;
  };
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
  functionCalls?: Array<{
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  }>;
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

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
};

const readString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return null;
};

const readNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
};

const extractPoint = (
  args: Record<string, unknown>,
): { x: number | null; y: number | null } => {
  const point =
    asRecord(args.coordinate) ??
    asRecord(args.coordinates) ??
    asRecord(args.position) ??
    asRecord(args.point);

  return {
    x: readNumber(args.x, point?.x, args.left),
    y: readNumber(args.y, point?.y, args.top),
  };
};

const toInt = (value: number | null): number | null => {
  if (value === null) {
    return null;
  }

  return Math.round(value);
};

const inferStartUrlFromGoal = (goal: string): string | null => {
  const explicitUrlMatch = goal.match(/https?:\/\/\S+/i);

  if (explicitUrlMatch?.[0]) {
    return explicitUrlMatch[0].replace(/[),.;]+$/, '');
  }

  const lowerGoal = goal.toLowerCase();

  if (lowerGoal.includes('youtube')) {
    return 'https://www.youtube.com/';
  }

  if (lowerGoal.includes('google maps')) {
    return 'https://www.google.com/maps';
  }

  if (lowerGoal.includes('google')) {
    return 'https://www.google.com/';
  }

  if (lowerGoal.includes('github')) {
    return 'https://github.com/';
  }

  return null;
};

const mapFunctionCallToPlannerOutput = (
  goal: string,
  history: StepRecord[],
  functionCall: { name?: string; args?: Record<string, unknown> },
): PlannerOutput => {
  const name = functionCall.name ?? '';
  const args = functionCall.args ?? {};
  const lowerName = name.toLowerCase();

  if (lowerName === 'open_web_browser' || lowerName === 'navigate') {
    const explicitUrl = readString(args.url, args.uri);
    const inferredUrl = inferStartUrlFromGoal(goal);
    const url = explicitUrl ?? inferredUrl;
    const lastAction = history[history.length - 1]?.action;
    const alreadyNavigatedToStartUrl =
      !explicitUrl &&
      typeof inferredUrl === 'string' &&
      lastAction?.type === 'navigate' &&
      lastAction.url === inferredUrl;

    if (alreadyNavigatedToStartUrl) {
      return {
        summary: 'Browser is already open',
        action: {
          type: 'wait',
          ms: 500,
        },
      };
    }

    if (!url) {
      return {
        summary: 'Browser opened and is ready',
        action: {
          type: 'wait',
          ms: 250,
        },
      };
    }

    return {
      summary: 'Open the requested page',
      action: {
        type: 'navigate',
        url,
      },
    };
  }

  if (lowerName === 'click_at' || lowerName === 'click') {
    const { x, y } = extractPoint(args);

    if (x === null || y === null) {
      throw new Error(`Computer Use tool call ${name} did not include click coordinates`);
    }

    return {
      summary: 'Click the visible target',
      action: {
        type: 'click',
        x: toInt(x) ?? 0,
        y: toInt(y) ?? 0,
      },
    };
  }

  if (
    lowerName === 'type_text' ||
    lowerName === 'type_text_at' ||
    lowerName === 'type'
  ) {
    const text = readString(args.text, args.value);

    if (text === null) {
      throw new Error(`Computer Use tool call ${name} did not include text`);
    }

    const { x, y } = extractPoint(args);

    return {
      summary: 'Type into the focused field',
      action: {
        type: 'type',
        text,
        ...(x !== null && y !== null
          ? {
              x: toInt(x) ?? 0,
              y: toInt(y) ?? 0,
            }
          : {}),
      },
    };
  }

  if (lowerName === 'press_key' || lowerName === 'key_press') {
    const key = readString(args.key, args.keyCode, args.code);

    if (!key) {
      throw new Error(`Computer Use tool call ${name} did not include a key`);
    }

    if (key.toLowerCase() === 'enter') {
      return {
        summary: 'Submit the current input',
        action: {
          type: 'type',
          text: '',
          submit: true,
        },
      };
    }

    throw new Error(`Unsupported Computer Use key press: ${key}`);
  }

  if (lowerName === 'scroll_by' || lowerName === 'scroll') {
    const deltaY = readNumber(args.deltaY, args.delta_y, args.y, args.amount);

    if (deltaY === null) {
      throw new Error(`Computer Use tool call ${name} did not include a scroll delta`);
    }

    return {
      summary: 'Scroll the page',
      action: {
        type: 'scroll',
        deltaY: Math.round(deltaY),
      },
    };
  }

  if (lowerName === 'wait') {
    const ms = readNumber(args.ms, args.milliseconds);
    const seconds = readNumber(args.seconds);
    const computedMs = ms ?? (seconds !== null ? seconds * 1000 : null);

    if (computedMs === null) {
      throw new Error(`Computer Use tool call ${name} did not include a wait duration`);
    }

    return {
      summary: 'Wait for the page to update',
      action: {
        type: 'wait',
        ms: Math.max(0, Math.round(computedMs)),
      },
    };
  }

  throw new Error(`Unsupported Computer Use tool call: ${name || 'unknown'}`);
};

const extractFunctionCalls = (
  response: PlannerSdkResponse,
): PlannerFunctionCall[] => {
  const toPlannerFunctionCall = (call: PlannerFunctionCall): PlannerFunctionCall => {
    return {
      ...(call.id ? { id: call.id } : {}),
      ...(call.name ? { name: call.name } : {}),
      ...(call.args ? { args: call.args } : {}),
    };
  };

  const directCalls =
    typeof response.functionCalls === 'function'
      ? response.functionCalls()
      : response.functionCalls;

  if (Array.isArray(directCalls) && directCalls.length > 0) {
    return directCalls.map(toPlannerFunctionCall);
  }

  const candidateParts = response.candidates?.[0]?.content?.parts ?? [];
  const partCalls = candidateParts
    .map((part) => part.functionCall)
    .filter((call): call is NonNullable<typeof call> => Boolean(call));

  return partCalls.map(toPlannerFunctionCall);
};

const buildPrompt = (
  goal: string,
  history: StepRecord[],
  viewport: PlannerViewport,
): string => {
  const maxX = viewport.width - 1;
  const maxY = viewport.height - 1;

  return [
    'You are controlling a browser with the built-in Computer Use tool.',
    'Use the current screenshot and recent actions to decide the next step.',
    'Do not call open_web_browser again if the browser is already open on the target site.',
    'After opening the site, prefer click_at, type_text, press_key, scroll_by, or wait.',
    'Only return JSON when the task is complete and the correct action is to stop.',
    'Done JSON shape:',
    '{"summary":"short completion note","action":{"type":"done","reason":"..."}}',
    `Goal: ${goal}`,
    `Recent history (${history.length}): ${JSON.stringify(history)}`,
  ].join(',');
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
  const request = {
    model,
    contents: requestLog.contents,
    config: requestLog.config,
  } as Parameters<typeof ai.models.generateContent>[0];
  const response = (await ai.models.generateContent(
    request,
  )) as PlannerSdkResponse;

  const rawText = response.text?.trim() ?? '';
  const functionCalls = extractFunctionCalls(response);
  const responseLog: PlannerResponseLog = {
    rawText,
    ...(functionCalls.length > 0
      ? {
          functionCalls,
        }
      : {}),
  };

  if (!rawText && functionCalls.length === 0) {
    throw new Error('Gemini planner returned neither text nor a Computer Use tool call');
  }

  if (functionCalls.length > 0) {
    const firstCall = functionCalls[0];

    if (!firstCall) {
      throw new Error('Computer Use returned an empty function call list');
    }

    responseLog.parsedOutput = mapFunctionCallToPlannerOutput(
      requestLog.goal,
      requestLog.history,
      firstCall,
    );
    return responseLog;
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
    config: {
      tools: [
        {
          computerUse: {
            environment: 'ENVIRONMENT_BROWSER',
          },
        },
      ],
    },
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
