import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { HumanHandoffReason } from '@replaypilot/shared';
import { detectState, type StateDetection } from './stateDetector';
import { withGeminiRetry } from '../lib/geminiRetry';

const MODEL_NAME =
  process.env.GEMINI_JUDGE_MODEL ?? process.env.GEMINI_HIGH_LEVEL_PLAN_MODEL ?? 'gemini-2.5-flash';

const JudgeVerdictSchema = z.enum([
  'PASS',
  'RETRY',
  'FAIL',
  'WAITING_FOR_HUMAN',
]);

const JudgeEvidenceSchema = z.object({
  text: z.string().min(1),
  region: z.string().min(1).optional(),
});

const VisionJudgeSchema = z.object({
  verdict: JudgeVerdictSchema,
  reasons: z.array(z.string().min(1)).min(1),
  evidence: z.array(JudgeEvidenceSchema),
});

const VisionJudgeResponseSchema = {
  type: 'OBJECT',
  properties: {
    verdict: {
      type: 'STRING',
      enum: ['PASS', 'RETRY', 'FAIL', 'WAITING_FOR_HUMAN'],
    },
    reasons: {
      type: 'ARRAY',
      items: {
        type: 'STRING',
      },
    },
    evidence: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          region: { type: 'STRING' },
        },
        required: ['text'],
      },
    },
  },
  required: ['verdict', 'reasons', 'evidence'],
} as const;

export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export type JudgeEvaluation = {
  verdict: JudgeVerdict;
  handoffReason?: HumanHandoffReason;
  reasonsFull: string[];
  reasonsUi: string[];
  evidence: Array<z.infer<typeof JudgeEvidenceSchema>>;
  screenshotHash: string;
  screenshotChanged: boolean;
  urlChanged: boolean;
  stateDetection: StateDetection;
};

type JudgeInput = {
  goal: string;
  stepIndex: number;
  stepCriteria: string;
  currentUrl: string;
  previousUrl: string | null;
  screenshotBytes: Buffer;
  previousScreenshotHash: string | null;
};

const getClient = (): GoogleGenAI => {
  const apiKey = process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY is required for judge evaluation');
  }

  return new GoogleGenAI({ apiKey });
};

const hashScreenshot = (screenshotBytes: Buffer): string => {
  return createHash('sha256').update(screenshotBytes).digest('hex');
};

const MAX_UI_REASON_LENGTH = 160;

const toUiReason = (reason: string): string => {
  if (reason.length <= MAX_UI_REASON_LENGTH) {
    return reason;
  }

  return `${reason.slice(0, MAX_UI_REASON_LENGTH - 3).trimEnd()}...`;
};

const toUiReasons = (reasons: string[]): string[] => {
  return reasons.map(toUiReason);
};

export const requiresSafetyConfirmation = (stepCriteria: string): boolean => {
  const normalized = stepCriteria.toLowerCase();

  return [
    'purchase',
    'buy',
    'checkout',
    'payment',
    'pay',
    'place order',
    'delete',
    'remove account',
    'submit application',
    'send message',
    'send email',
    'confirm booking',
  ].some((term) => normalized.includes(term));
};

const buildVisionJudgePrompt = (input: JudgeInput): string => {
  return [
    'You are a strict visual judge for a browser automation step.',
    'Decide only from the screenshot, URL context, and the provided step criteria.',
    'Return whether the current screen satisfies the step.',
    `Goal: ${input.goal}`,
    `Step ${input.stepIndex + 1} criteria: ${input.stepCriteria}`,
    `Current URL: ${input.currentUrl}`,
    'Return PASS if the step is complete or if the expected post-action state is already reached (for example: already logged in, redirected to the target page, or target control is gone because the action succeeded).',
    'Return RETRY if the step is not complete but progress appears possible, including when the UI changed after interaction and the next action is still feasible.',
    'Return FAIL only for clear dead ends: explicit error state, blocked access, irreversible wrong page, or no realistic path forward.',
    'Return WAITING_FOR_HUMAN if the screenshot shows CAPTCHA, explicit human verification, or a sensitive confirmation gate.',
    'Do not return FAIL only because a previously clicked button is no longer visible. Include short reasons and cite visible text or UI cues as evidence.',
  ].join('\n');
};

const runVisionJudge = async (input: JudgeInput): Promise<z.infer<typeof VisionJudgeSchema>> => {
  const ai = getClient();
  const response = await withGeminiRetry(
    async () =>
      ai.models.generateContent({
        model: MODEL_NAME,
        contents: [
          { text: buildVisionJudgePrompt(input) },
          {
            inlineData: {
              mimeType: 'image/png',
              data: input.screenshotBytes.toString('base64'),
            },
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: VisionJudgeResponseSchema,
        },
      }),
    { label: 'vision-judge' },
  );
  const rawText = response.text?.trim() ?? '';

  if (!rawText) {
    throw new Error('Gemini judge returned empty output');
  }

  return VisionJudgeSchema.parse(JSON.parse(rawText));
};

export const evaluateStep = async (
  input: JudgeInput,
): Promise<JudgeEvaluation> => {
  const screenshotHash = hashScreenshot(input.screenshotBytes);
  const screenshotChanged =
    input.previousScreenshotHash === null ||
    input.previousScreenshotHash !== screenshotHash;
  const urlChanged =
    input.previousUrl !== null && input.previousUrl !== input.currentUrl;

  const stateDetection = await detectState(input.screenshotBytes, input.currentUrl);

  if (stateDetection.blockers.some((blocker) => blocker.type === 'captcha')) {
    return {
      verdict: 'WAITING_FOR_HUMAN',
      handoffReason: 'CAPTCHA_DETECTED',
      reasonsFull: ['CAPTCHA detected by visual state detector'],
      reasonsUi: ['CAPTCHA detected by visual state detector'],
      evidence: stateDetection.blockers.map((blocker) => ({
        text: blocker.reason,
      })),
      screenshotHash,
      screenshotChanged,
      urlChanged,
      stateDetection,
    };
  }

  const visionJudge = await runVisionJudge(input);

  if (visionJudge.verdict === 'PASS') {
    return {
      verdict: 'PASS',
      reasonsFull: visionJudge.reasons,
      reasonsUi: toUiReasons(visionJudge.reasons),
      evidence: visionJudge.evidence,
      screenshotHash,
      screenshotChanged,
      urlChanged,
      stateDetection,
    };
  }

  if (visionJudge.verdict === 'WAITING_FOR_HUMAN') {
    return {
      verdict: 'WAITING_FOR_HUMAN',
      handoffReason: 'CAPTCHA_DETECTED',
      reasonsFull: visionJudge.reasons,
      reasonsUi: toUiReasons(visionJudge.reasons),
      evidence: visionJudge.evidence,
      screenshotHash,
      screenshotChanged,
      urlChanged,
      stateDetection,
    };
  }
  if (visionJudge.verdict === 'FAIL') {
    return {
      verdict: 'FAIL',
      reasonsFull: visionJudge.reasons,
      reasonsUi: toUiReasons(visionJudge.reasons),
      evidence: visionJudge.evidence,
      screenshotHash,
      screenshotChanged,
      urlChanged,
      stateDetection,
    };
  }

  if (screenshotChanged || urlChanged) {
    return {
      verdict: 'RETRY',
      reasonsFull: visionJudge.reasons,
      reasonsUi: toUiReasons(visionJudge.reasons),
      evidence: visionJudge.evidence,
      screenshotHash,
      screenshotChanged,
      urlChanged,
      stateDetection,
    };
  }

  return {
    verdict: 'FAIL',
    reasonsFull: [...visionJudge.reasons, 'No deterministic progress signal was detected'],
    reasonsUi: toUiReasons([
      ...visionJudge.reasons,
      'No deterministic progress signal was detected',
    ]),
    evidence: visionJudge.evidence,
    screenshotHash,
    screenshotChanged,
    urlChanged,
    stateDetection,
  };
};



