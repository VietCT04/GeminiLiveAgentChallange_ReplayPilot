import {
  type Action,
  type RunState,
  type StepRecord,
} from '@replaypilot/shared';
import { chromium, type Browser, type Page } from 'playwright';
import { planNextActionDetailed } from '../planner/geminiPlanner';
import {
  appendHistory,
  getRun,
  resolveArtifactPath,
  updateRun,
  writeArtifactJson,
} from './run-store';

const MAX_STEPS = 30;
const NAVIGATION_TIMEOUT_MS = 15000;
const STEP_SETTLE_MS = 800;
const PLANNER_SCREENSHOT_NAME = 'planner_%STEP%.png';

const allowedNavigationHosts = new Set([
  'youtube.com',
  'www.youtube.com',
  'consent.youtube.com',
  'accounts.google.com',
]);

const formatStepFileName = (
  prefix: string,
  index: number,
  extension: string,
): string => {
  return `${prefix}_${String(index).padStart(2, '0')}.${extension}`;
};

const wait = async (page: Page, ms: number): Promise<void> => {
  await page.waitForTimeout(ms);
};

const isTerminalStatus = (status: RunState['status']): boolean => {
  return status === 'success' || status === 'fail' || status === 'stopped';
};

const shouldStop = async (runId: string): Promise<boolean> => {
  const runState = await getRun(runId);
  return runState.status === 'stopped';
};

const ensureAllowedNavigate = (action: Action): void => {
  if (action.type !== 'navigate') {
    return;
  }

  let url: URL;

  try {
    url = new URL(action.url);
  } catch {
    throw new Error(`Planner returned invalid navigation URL: ${action.url}`);
  }

  if (!allowedNavigationHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`Blocked navigation host from planner: ${url.hostname}`);
  }
};

const ensureNoLoop = (history: StepRecord[], action: Action): void => {
  if (history.length < 2) {
    return;
  }

  const actionKey = JSON.stringify(action);
  const lastTwo = history.slice(-2).map((entry) => JSON.stringify(entry.action));

  if (lastTwo.every((entry) => entry === actionKey)) {
    throw new Error(`Planner repeated the same action 3 times: ${actionKey}`);
  }
};

export const executeAction = async (page: Page, action: Action): Promise<void> => {
  switch (action.type) {
    case 'navigate':
      await page.goto(action.url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      break;
    case 'click':
      await page.mouse.click(action.x, action.y, {
        button: action.button ?? 'left',
        clickCount: action.clicks ?? 1,
      });
      break;
    case 'type':
      if (typeof action.x === 'number' && typeof action.y === 'number') {
        await page.mouse.click(action.x, action.y);
      }
      await page.keyboard.type(action.text, { delay: 40 });
      if (action.submit) {
        await page.keyboard.press('Enter');
      }
      break;
    case 'scroll':
      await page.mouse.wheel(0, action.deltaY);
      break;
    case 'wait':
      await wait(page, action.ms);
      break;
    case 'done':
      break;
    default: {
      const exhaustiveCheck: never = action;
      throw new Error(`Unsupported action: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
};

const captureActionStep = async (
  runId: string,
  page: Page,
  index: number,
  action: Action,
): Promise<void> => {
  const screenshotName = formatStepFileName('step', index, 'png');
  const screenshotPath = resolveArtifactPath(runId, screenshotName);

  await page.screenshot({
    path: screenshotPath,
    fullPage: false,
  });

  await appendHistory(runId, {
    index,
    ts: Date.now(),
    action,
    screenshotName,
  });

  await updateRun(runId, {
    status: 'running',
    step: index + 1,
    lastAction: action,
    lastScreenshotUrl: `/runs/${runId}/artifacts/${screenshotName}`,
    updatedAt: Date.now(),
  });
};

const writePlannerDebugFiles = async (
  runId: string,
  index: number,
  debug: unknown,
): Promise<void> => {
  await writeArtifactJson(
    runId,
    formatStepFileName('planner_request', index, 'json'),
    (debug as { request: unknown }).request,
  );
  await writeArtifactJson(
    runId,
    formatStepFileName('planner_response', index, 'json'),
    (debug as { response: unknown }).response,
  );
};

const closeBrowser = async (browser: Browser | null): Promise<void> => {
  if (browser) {
    await browser.close();
  }
};

export const runDemoSequence = async (
  runId: string,
  log: { info: (context: object, message: string) => void },
): Promise<void> => {
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 720,
      },
    });
    const page = await context.newPage();

    for (let index = 0; index < MAX_STEPS; index += 1) {
      if (await shouldStop(runId)) {
        log.info({ runId }, 'Demo run stopped before planning next action');
        break;
      }

      const currentRun = await getRun(runId);
      const plannerScreenshot = await page.screenshot({
        fullPage: false,
      });

      const { action, debug } = await planNextActionDetailed(
        currentRun.goal,
        plannerScreenshot,
        currentRun.history,
      );

      await writePlannerDebugFiles(runId, index, debug);
      ensureAllowedNavigate(action);
      ensureNoLoop(currentRun.history, action);

      if (action.type === 'done') {
        await appendHistory(runId, {
          index,
          ts: Date.now(),
          action,
        });
        await updateRun(runId, {
          status: 'success',
          step: index + 1,
          lastAction: action,
          updatedAt: Date.now(),
        });
        log.info({ runId, step: index, reason: action.reason }, 'Demo run done');
        break;
      }

      await executeAction(page, action);
      await wait(page, STEP_SETTLE_MS);

      if (await shouldStop(runId)) {
        log.info({ runId }, 'Demo run stopped after action execution');
        break;
      }

      await captureActionStep(runId, page, index, action);
      log.info(
        { runId, step: index, actionType: action.type },
        'Captured demo step',
      );
    }

    const latestRunState = await getRun(runId);

    if (!isTerminalStatus(latestRunState.status)) {
      throw new Error(`Planner reached max steps (${MAX_STEPS}) without finishing`);
    }

    await context.close();
  } catch (error) {
    await updateRun(runId, {
      status: 'fail',
      updatedAt: Date.now(),
      error:
        error instanceof Error ? error.message : 'Demo run execution failed',
    });
    throw error;
  } finally {
    await closeBrowser(browser);
  }
};
