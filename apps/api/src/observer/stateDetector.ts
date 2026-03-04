import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

const MODEL_NAME = 'gemini-2.5-flash';

export const DetectorPhaseSchema = z.enum([
  'landing',
  'search_results',
  'detail',
  'form',
  'checkout',
  'auth',
  'consent',
  'modal_blocking',
  'loading',
  'error',
  'unknown',
]);

export const DetectorAffordancesSchema = z.object({
  hasSearchInput: z.boolean(),
  hasTextInputs: z.boolean(),
  hasPrimaryButton: z.boolean(),
  hasResultsList: z.boolean(),
  hasScrollableContent: z.boolean(),
  hasConfirmationMessage: z.boolean(),
});

export const DetectorBlockerSchema = z.object({
  type: z.enum([
    'consent',
    'signin',
    'captcha',
    'popup',
    'modal',
    'interstitial',
  ]),
  reason: z.string(),
});

export const StateDetectionSchema = z.object({
  phase: DetectorPhaseSchema,
  affordances: DetectorAffordancesSchema,
  blockers: z.array(DetectorBlockerSchema),
  reason: z.string(),
});

export type StateDetection = z.infer<typeof StateDetectionSchema>;

const fallbackDetection: StateDetection = {
  phase: 'unknown',
  affordances: {
    hasSearchInput: false,
    hasTextInputs: false,
    hasPrimaryButton: false,
    hasResultsList: false,
    hasScrollableContent: false,
    hasConfirmationMessage: false,
  },
  blockers: [],
  reason: 'invalid_detector_output',
};

const StateDetectionResponseSchema = {
  type: 'OBJECT',
  properties: {
    phase: {
      type: 'STRING',
      enum: [
        'landing',
        'search_results',
        'detail',
        'form',
        'checkout',
        'auth',
        'consent',
        'modal_blocking',
        'loading',
        'error',
        'unknown',
      ],
    },
    affordances: {
      type: 'OBJECT',
      properties: {
        hasSearchInput: { type: 'BOOLEAN' },
        hasTextInputs: { type: 'BOOLEAN' },
        hasPrimaryButton: { type: 'BOOLEAN' },
        hasResultsList: { type: 'BOOLEAN' },
        hasScrollableContent: { type: 'BOOLEAN' },
        hasConfirmationMessage: { type: 'BOOLEAN' },
      },
      required: [
        'hasSearchInput',
        'hasTextInputs',
        'hasPrimaryButton',
        'hasResultsList',
        'hasScrollableContent',
        'hasConfirmationMessage',
      ],
    },
    blockers: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: {
            type: 'STRING',
            enum: [
              'consent',
              'signin',
              'captcha',
              'popup',
              'modal',
              'interstitial',
            ],
          },
          reason: {
            type: 'STRING',
          },
        },
        required: ['type', 'reason'],
      },
    },
    reason: {
      type: 'STRING',
    },
  },
  required: ['phase', 'affordances', 'blockers', 'reason'],
} as const;

const getClient = (): GoogleGenAI => {
  const apiKey = process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY is required for state detection');
  }

  return new GoogleGenAI({ apiKey });
};

const buildPrompt = (url: string): string => {
  return [
    'You are a site-agnostic browser state detector for a screenshot-driven agent.',
    'Decide only from the screenshot pixels and the current URL.',
    'Do not use site-specific labels or names.',
    'Return ONLY strict JSON with exactly this shape:',
    '{"phase":"landing|search_results|detail|form|checkout|auth|consent|modal_blocking|loading|error|unknown","affordances":{"hasSearchInput":false,"hasTextInputs":false,"hasPrimaryButton":false,"hasResultsList":false,"hasScrollableContent":false,"hasConfirmationMessage":false},"blockers":[{"type":"consent|signin|captcha|popup|modal|interstitial","reason":"short reason"}],"reason":"short reason"}',
    'No markdown. No code fences. No extra text.',
    'Keep the "reason" short.',
    `Current URL: ${url}`,
  ].join('\n');
};

export const detectState = async (
  screenshotBytes: Buffer,
  url: string,
): Promise<StateDetection> => {
  const prompt = buildPrompt(url);
  const ai = getClient();

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: [
      { text: prompt },
      {
        inlineData: {
          mimeType: 'image/png',
          data: screenshotBytes.toString('base64'),
        },
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: StateDetectionResponseSchema,
    },
  });

  const rawText = response.text?.trim() ?? '';

  if (!rawText) {
    return fallbackDetection;
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    return fallbackDetection;
  }

  const parsed = StateDetectionSchema.safeParse(parsedJson);

  if (!parsed.success) {
    return fallbackDetection;
  }

  return parsed.data;
};
