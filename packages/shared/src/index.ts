import { z } from 'zod';

export const ActionTypeSchema = z.enum([
  'navigate',
  'click',
  'type',
  'scroll',
  'wait',
  'done',
]);

export type ActionType = z.infer<typeof ActionTypeSchema>;

export const NavigateActionSchema = z.object({
  type: z.literal('navigate'),
  url: z.string().url(),
});

export type NavigateAction = z.infer<typeof NavigateActionSchema>;

export const ClickActionSchema = z.object({
  type: z.literal('click'),
  x: z.number(),
  y: z.number(),
  button: z.enum(['left', 'middle', 'right']).optional(),
  clicks: z.number().int().positive().optional(),
});

export type ClickAction = z.infer<typeof ClickActionSchema>;

export const TypeActionSchema = z.object({
  type: z.literal('type'),
  text: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  submit: z.boolean().optional(),
});

export type TypeAction = z.infer<typeof TypeActionSchema>;

export const ScrollActionSchema = z.object({
  type: z.literal('scroll'),
  deltaY: z.number(),
});

export type ScrollAction = z.infer<typeof ScrollActionSchema>;

export const WaitActionSchema = z.object({
  type: z.literal('wait'),
  ms: z.number().int().nonnegative(),
});

export type WaitAction = z.infer<typeof WaitActionSchema>;

export const DoneActionSchema = z.object({
  type: z.literal('done'),
  reason: z.string(),
});

export type DoneAction = z.infer<typeof DoneActionSchema>;

export const ActionSchema = z.discriminatedUnion('type', [
  NavigateActionSchema,
  ClickActionSchema,
  TypeActionSchema,
  ScrollActionSchema,
  WaitActionSchema,
  DoneActionSchema,
]);

export type Action = z.infer<typeof ActionSchema>;

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_for_human',
  'success',
  'fail',
  'stopped',
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

export const HumanHandoffReasonSchema = z.enum([
  'CAPTCHA_DETECTED',
  'SAFETY_CONFIRMATION_PENDING',
]);

export type HumanHandoffReason = z.infer<typeof HumanHandoffReasonSchema>;

export const HumanHandoffSchema = z.object({
  reason: HumanHandoffReasonSchema,
  url: z.string(),
  screenshotUrl: z.string().optional(),
});

export type HumanHandoff = z.infer<typeof HumanHandoffSchema>;

export const StepRecordSchema = z.object({
  index: z.number().int().nonnegative(),
  ts: z.number(),
  action: ActionSchema,
  screenshotName: z.string().optional(),
  note: z.string().optional(),
});

export type StepRecord = z.infer<typeof StepRecordSchema>;

export const RunStateSchema = z.object({
  runId: z.string(),
  goal: z.string(),
  planSteps: z.array(z.string()).default([]),
  completedPlanSteps: z.number().int().nonnegative().default(0),
  approvedSafetyStep: z.string().optional(),
  status: RunStatusSchema,
  step: z.number().int().nonnegative(),
  startedAt: z.number(),
  updatedAt: z.number(),
  lastAction: ActionSchema.optional(),
  lastScreenshotUrl: z.string().optional(),
  error: z.string().optional(),
  handoff: HumanHandoffSchema.optional(),
  history: z.array(StepRecordSchema),
});

export type RunState = z.infer<typeof RunStateSchema>;

export const StartRunRequestSchema = z.object({
  goal: z.string().trim().min(1).max(500),
  planSteps: z.array(z.string().trim().min(1).max(200)).optional(),
});

export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export const GeneratePlanRequestSchema = z.object({
  goal: z.string().trim().min(1).max(500),
});

export type GeneratePlanRequest = z.infer<typeof GeneratePlanRequestSchema>;

export const GeneratePlanResponseSchema = z.object({
  goal: z.string(),
  summary: z.string().trim().min(1),
  steps: z.array(z.string().trim().min(1).max(200)).min(1),
});

export type GeneratePlanResponse = z.infer<typeof GeneratePlanResponseSchema>;

export const StartRunResponseSchema = z.object({
  runId: z.string(),
});

export type StartRunResponse = z.infer<typeof StartRunResponseSchema>;
