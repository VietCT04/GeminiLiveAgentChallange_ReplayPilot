import { chromium, type Page } from 'playwright';
import { config as loadEnv } from 'dotenv';
import {
  ActionSchema,
  type Action,
  type RunState,
  type StartRunResponse,
} from '@replaypilot/shared';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as path from 'node:path';

loadEnv({
  path: path.resolve(__dirname, '..', '..', '..', '..', '.env'),
});

type ToolCall = {
  name?: string;
  args?: Record<string, unknown>;
};

type PlanNextComputerUseResponse = {
  planner: 'computer-use';
  toolCall?: ToolCall;
  actionPreview: Action;
  summary: string;
  runState: RunState;
};

type ReportStepResponse = {
  verdict: 'PASS' | 'RETRY' | 'FAIL' | 'WAITING_FOR_HUMAN';
  reasonsUi: string[];
  reasonsFull: string[];
  screenshotHash: string;
  runState: RunState;
};

type PendingRunsResponse = {
  pending: Array<{
    runId: string;
    goal: string;
  }>;
};

const DEFAULT_VIEWPORT = {
  width: 1280,
  height: 720,
};
const DEFAULT_START_URL = 'https://www.google.com/';

const readArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};

const toUrl = (baseUrl: string, path: string): string => {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
};

const postJson = async <T>(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<T> => {
  const response = await fetch(toUrl(baseUrl, path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`POST ${path} failed (${response.status}): ${text}`);
  }

  return (await response.json()) as T;
};

const getJson = async <T>(baseUrl: string, path: string): Promise<T> => {
  const response = await fetch(toUrl(baseUrl, path), {
    method: 'GET',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GET ${path} failed (${response.status}): ${text}`);
  }

  return (await response.json()) as T;
};

const takeScreenshotBase64 = async (page: Page): Promise<string> => {
  const bytes = await page.screenshot({
    fullPage: false,
    type: 'png',
  });
  return bytes.toString('base64');
};

const denormalizeCoordinate = (value: number, size: number): number => {
  const scaled = Math.floor((value / 1000) * size);
  return Math.min(Math.max(scaled, 0), size - 1);
};

const extractPoint = (
  args: Record<string, unknown>,
): { x: number; y: number } | null => {
  const asRecord = (value: unknown): Record<string, unknown> | null => {
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : null;
  };
  const point =
    asRecord(args.coordinate) ??
    asRecord(args.coordinates) ??
    asRecord(args.position) ??
    asRecord(args.point);
  const x =
    typeof args.x === 'number'
      ? args.x
      : typeof point?.x === 'number'
        ? point.x
        : typeof args.left === 'number'
          ? args.left
          : null;
  const y =
    typeof args.y === 'number'
      ? args.y
      : typeof point?.y === 'number'
        ? point.y
        : typeof args.top === 'number'
          ? args.top
          : null;

  if (typeof x !== 'number' || typeof y !== 'number') {
    return null;
  }

  return {
    x: denormalizeCoordinate(x, DEFAULT_VIEWPORT.width),
    y: denormalizeCoordinate(y, DEFAULT_VIEWPORT.height),
  };
};

const clearFocusedField = async (page: Page): Promise<void> => {
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
};

const normalizeToolName = (name: string): string => {
  const lowerName = name.toLowerCase();

  switch (lowerName) {
    case 'open_browser':
    case 'launch_browser':
      return 'open_web_browser';
    case 'go_to':
    case 'goto':
    case 'open_url':
      return 'navigate';
    case 'left_click':
    case 'single_click':
    case 'click_element':
      return 'click';
    case 'type_into':
    case 'enter_text':
    case 'input_text':
      return 'type';
    case 'press_enter':
    case 'hit_enter':
      return 'press_key';
    case 'scroll_down':
      return 'scroll';
    case 'scroll_up':
      return 'scroll';
    case 'scroll_document':
    case 'scroll_at':
      return 'scroll';
    default:
      return lowerName;
  }
};

const executeToolCall = async (
  page: Page,
  goal: string,
  toolCall: ToolCall,
): Promise<void> => {
  const args = toolCall.args ?? {};
  const name = normalizeToolName(toolCall.name ?? '');

  switch (name) {
    case 'open_web_browser':
    case 'navigate': {
      const url =
        (typeof args.url === 'string' ? args.url : null) ??
        (typeof args.uri === 'string' ? args.uri : null) ??
        (goal.toLowerCase().includes('youtube') ? 'https://www.youtube.com/' : null);

      if (!url) {
        await page.waitForTimeout(250);
        return;
      }

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      return;
    }
    case 'click_at':
    case 'click': {
      const point = extractPoint(args);
      if (!point) {
        throw new Error(`Tool call ${toolCall.name ?? 'unknown'} missing click coordinates`);
      }
      await page.mouse.click(point.x, point.y, {
        button:
          args.button === 'middle' || args.button === 'right' ? args.button : 'left',
        clickCount:
          typeof args.clicks === 'number' && Number.isInteger(args.clicks) && args.clicks > 0
            ? args.clicks
            : 1,
      });
      return;
    }
    case 'type_text':
    case 'type_text_at':
    case 'type': {
      const text =
        typeof args.text === 'string'
          ? args.text
          : typeof args.value === 'string'
            ? args.value
            : null;

      if (text === null) {
        throw new Error(`Tool call ${toolCall.name ?? 'unknown'} missing text`);
      }

      const point = extractPoint(args);
      if (point) {
        await page.mouse.click(point.x, point.y);
      }

      await clearFocusedField(page);
      await page.keyboard.type(text, { delay: 40 });

      const shouldPressEnter =
        args.press_enter === true ||
        args.pressEnter === true ||
        args.submit === true ||
        args.enter === true;

      if (shouldPressEnter) {
        await page.keyboard.press('Enter');
      }
      return;
    }
    case 'press_key':
    case 'key_press': {
      const key =
        typeof args.key === 'string'
          ? args.key
          : typeof args.keyCode === 'string'
            ? args.keyCode
            : typeof args.code === 'string'
              ? args.code
              : null;
      if (!key) {
        throw new Error(`Tool call ${toolCall.name ?? 'unknown'} missing key`);
      }
      await page.keyboard.press(key);
      return;
    }
    case 'scroll_by':
    case 'scroll': {
      const direction = typeof args.direction === 'string' ? args.direction.toLowerCase() : null;
      const deltaX =
        typeof args.deltaX === 'number'
          ? args.deltaX
          : typeof args.delta_x === 'number'
            ? args.delta_x
            : typeof args.x === 'number'
              ? args.x
              : direction === 'right'
                ? 400
                : direction === 'left'
                  ? -400
                  : 0;
      const deltaY =
        typeof args.deltaY === 'number'
          ? args.deltaY
          : typeof args.delta_y === 'number'
            ? args.delta_y
            : typeof args.amount === 'number'
              ? args.amount
              : typeof args.y === 'number'
                ? args.y
                : direction === 'down'
                  ? 600
                  : direction === 'up'
                    ? -600
                : name === 'scroll'
                  ? 600
                  : null;
      if (deltaY === null && deltaX === 0) {
        throw new Error(`Tool call ${toolCall.name ?? 'unknown'} missing scroll delta`);
      }
      await page.mouse.wheel(deltaX, deltaY ?? 0);
      return;
    }
    case 'wait': {
      const ms =
        typeof args.ms === 'number'
          ? args.ms
          : typeof args.milliseconds === 'number'
            ? args.milliseconds
            : typeof args.seconds === 'number'
              ? args.seconds * 1000
              : 500;
      await page.waitForTimeout(Math.max(0, Math.round(ms)));
      return;
    }
    default:
      throw new Error(`Unsupported tool call: ${toolCall.name ?? 'unknown'}`);
  }
};

const pauseForHuman = async (
  orchestratorBaseUrl: string,
  runId: string,
): Promise<void> => {
  const rl = createInterface({ input, output });
  await rl.question(
    '\nRun is waiting for human. Solve CAPTCHA/confirmation in browser, then press Enter to resume...',
  );
  rl.close();

  await postJson<RunState>(orchestratorBaseUrl, `/runs/${runId}/resume`, {});
};

const executeRun = async (
  orchestratorBaseUrl: string,
  runId: string,
  goal: string,
  headless: boolean,
): Promise<void> => {
  console.log(`Executing run ${runId}`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
  });
  const page = await context.newPage();

  let previousUrl: string | null = null;
  let previousScreenshotHash: string | null = null;

  try {
    await page.goto(DEFAULT_START_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    const currentRunState = await getJson<RunState>(orchestratorBaseUrl, `/runs/${runId}`);
    if (currentRunState.history.length === 0) {
      const initialScreenshotBase64 = await takeScreenshotBase64(page);
      const initialReport = await postJson<ReportStepResponse>(
        orchestratorBaseUrl,
        `/runs/${runId}/orchestrator/report-step`,
        {
          action: {
            type: 'navigate',
            url: DEFAULT_START_URL,
          },
          summary: 'Opened Google automatically as the start page',
          screenshotBase64: initialScreenshotBase64,
          currentUrl: page.url(),
          previousUrl,
          previousScreenshotHash,
        },
      );
      previousUrl = page.url();
      previousScreenshotHash = initialReport.screenshotHash;
    }

    for (;;) {
      const plannerScreenshotBase64 = await takeScreenshotBase64(page);
      const planNextResponse = await postJson<PlanNextComputerUseResponse>(
        orchestratorBaseUrl,
        `/runs/${runId}/orchestrator/plan-next`,
        {
          screenshotBase64: plannerScreenshotBase64,
          viewport: DEFAULT_VIEWPORT,
        },
      );

      const actionToReport = ActionSchema.parse(planNextResponse.actionPreview);
      if (planNextResponse.toolCall) {
        await executeToolCall(page, goal, planNextResponse.toolCall);
      } else if (actionToReport.type !== 'done') {
        throw new Error('No tool call returned for non-done computer-use step');
      }

      const reportedScreenshotBase64 = await takeScreenshotBase64(page);
      const stepReport: ReportStepResponse = await postJson<ReportStepResponse>(
        orchestratorBaseUrl,
        `/runs/${runId}/orchestrator/report-step`,
        {
          action: actionToReport,
          summary: planNextResponse.summary,
          screenshotBase64: reportedScreenshotBase64,
          currentUrl: page.url(),
          previousUrl,
          previousScreenshotHash,
        },
      );

      previousUrl = page.url();
      previousScreenshotHash = stepReport.screenshotHash;
      console.log(
        `Step verdict=${stepReport.verdict} status=${stepReport.runState.status} reasons=${stepReport.reasonsUi.join(' | ')}`,
      );

      if (stepReport.runState.status === 'success') {
        console.log(`Run ${runId} succeeded.`);
        break;
      }

      if (
        stepReport.runState.status === 'fail' ||
        stepReport.runState.status === 'stopped'
      ) {
        console.log(`Run ${runId} ended with status ${stepReport.runState.status}.`);
        break;
      }

      if (stepReport.runState.status === 'waiting_for_human') {
        await pauseForHuman(orchestratorBaseUrl, runId);
      }
    }
  } finally {
    await browser.close();
  }
};

const run = async (): Promise<void> => {
  const orchestratorBaseUrl =
    readArg('orchestrator-url') ??
    process.env.REPLAYPILOT_ORCHESTRATOR_URL;
  const headless = (readArg('headless') ?? process.env.EXECUTOR_HEADLESS ?? 'false') === 'true';
  const watchMode = (readArg('watch') ?? 'false').toLowerCase() === 'true';
  const runIdArg = readArg('run-id');
  const goalArg = readArg('goal');

  if (!orchestratorBaseUrl) {
    throw new Error(
      'Missing orchestrator URL. Provide --orchestrator-url="https://..." or set REPLAYPILOT_ORCHESTRATOR_URL.',
    );
  }

  if (watchMode) {
    console.log('Executor watch mode started. Waiting for new orchestrator runs...');
    const running = new Set<string>();

    for (;;) {
      const pendingResponse = await getJson<PendingRunsResponse>(
        orchestratorBaseUrl,
        '/runs/orchestrator/pending',
      );

      for (const runInfo of pendingResponse.pending) {
        if (running.has(runInfo.runId)) {
          continue;
        }

        running.add(runInfo.runId);
        try {
          await executeRun(orchestratorBaseUrl, runInfo.runId, runInfo.goal, headless);
        } finally {
          running.delete(runInfo.runId);
        }
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1500);
      });
    }
  }

  if (runIdArg) {
    const existingRun = await getJson<RunState>(orchestratorBaseUrl, `/runs/${runIdArg}`);
    await executeRun(orchestratorBaseUrl, existingRun.runId, existingRun.goal, headless);
    return;
  }

  const rl = createInterface({ input, output });
  const goal = goalArg ?? (await rl.question('Enter goal: ')).trim();
  rl.close();

  if (!goal) {
    throw new Error('Missing goal. Please enter a non-empty goal.');
  }

  const plan = await postJson<{ steps: string[]; summary: string }>(
    orchestratorBaseUrl,
    '/runs/plan',
    { goal },
  );
  const started = await postJson<StartRunResponse>(
    orchestratorBaseUrl,
    '/runs/orchestrator/start',
    {
      goal,
      planSteps: plan.steps,
    },
  );

  await executeRun(orchestratorBaseUrl, started.runId, goal, headless);
};

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
