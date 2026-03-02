import {
  RunStateSchema,
  StepRecordSchema,
  type RunState,
  type StepRecord,
} from '@replaypilot/shared';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

const runsRoot = path.resolve(__dirname, '..', '..', 'data', 'runs');

const getRunDir = (runId: string): string => {
  return path.join(runsRoot, runId);
};

const getRunFile = (runId: string): string => {
  return path.join(getRunDir(runId), 'run.json');
};

const writeRun = async (runState: RunState): Promise<RunState> => {
  const validatedRun = RunStateSchema.parse(runState);
  await mkdir(getRunDir(validatedRun.runId), { recursive: true });
  await writeFile(
    getRunFile(validatedRun.runId),
    JSON.stringify(validatedRun, null, 2),
    'utf8',
  );
  return validatedRun;
};

export const createRun = async (goal: string): Promise<RunState> => {
  const now = Date.now();
  const initialRun: RunState = {
    runId: randomUUID(),
    goal,
    status: 'queued',
    step: 0,
    startedAt: now,
    updatedAt: now,
    history: [],
  };

  const queuedRun = await writeRun(initialRun);
  return updateRun(queuedRun.runId, {
    status: 'running',
    updatedAt: Date.now(),
  });
};

export const getRun = async (runId: string): Promise<RunState> => {
  const raw = await readFile(getRunFile(runId), 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return RunStateSchema.parse(parsed);
};

export const updateRun = async (
  runId: string,
  patch: Partial<RunState>,
): Promise<RunState> => {
  const existingRun = await getRun(runId);
  const nextRun: RunState = {
    ...existingRun,
    ...patch,
    runId: existingRun.runId,
  };
  return writeRun(nextRun);
};

export const appendHistory = async (
  runId: string,
  stepRecord: StepRecord,
): Promise<RunState> => {
  const existingRun = await getRun(runId);
  const validatedStep = StepRecordSchema.parse(stepRecord);
  return writeRun({
    ...existingRun,
    history: [...existingRun.history, validatedStep],
    updatedAt: Date.now(),
  });
};

export const resolveRunDir = (runId: string): string => {
  return getRunDir(runId);
};

export const resolveArtifactPath = (runId: string, name: string): string => {
  const runDir = getRunDir(runId);
  const artifactPath = path.resolve(runDir, name);
  const relativePath = path.relative(runDir, artifactPath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Invalid artifact path');
  }

  return artifactPath;
};

export const writeArtifactJson = async (
  runId: string,
  name: string,
  value: unknown,
): Promise<void> => {
  const artifactPath = resolveArtifactPath(runId, name);
  await writeFile(artifactPath, JSON.stringify(value, null, 2), 'utf8');
};
