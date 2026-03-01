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
  'success',
  'fail',
  'stopped',
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

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
  status: RunStatusSchema,
  step: z.number().int().nonnegative(),
  startedAt: z.number(),
  updatedAt: z.number(),
  lastAction: ActionSchema.optional(),
  lastScreenshotUrl: z.string().optional(),
  error: z.string().optional(),
  history: z.array(StepRecordSchema),
});

export type RunState = z.infer<typeof RunStateSchema>;

export const StartRunResponseSchema = z.object({
  runId: z.string(),
});

export type StartRunResponse = z.infer<typeof StartRunResponseSchema>;
