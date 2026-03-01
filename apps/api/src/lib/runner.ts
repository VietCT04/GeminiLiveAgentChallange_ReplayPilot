import { type Action, type RunState } from '@replaypilot/shared';
import { chromium, type Browser, type Page } from 'playwright';
import {
  appendHistory,
  getRun,
  resolveArtifactPath,
  updateRun,
} from './run-store';

const MAX_STEPS = 10;
const NAVIGATION_TIMEOUT_MS = 15000;
const STEP_SETTLE_MS = 800;
const INITIAL_SETTLE_MS = 500;

const formatStepScreenshotName = (index: number): string => {
  return `step_${String(index).padStart(2, '0')}.png`;
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

const captureStep = async (
  runId: string,
  page: Page,
  index: number,
  action: Action,
): Promise<void> => {
  const screenshotName = formatStepScreenshotName(index);
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

const closeBrowser = async (browser: Browser | null): Promise<void> => {
  if (browser) {
    await browser.close();
  }
};

export const runDemoSequence = async (
  runId: string,
  log: { info: (context: object, message: string) => void },
): Promise<void> => {
  const actions: Action[] = [
    { type: 'navigate', url: 'https://www.youtube.com' },
    { type: 'click', x: 640, y: 92 },
    { type: 'type', text: 'Adele Hello official music video' },
    { type: 'wait', ms: 600 },
    { type: 'click', x: 1135, y: 91 },
    { type: 'wait', ms: 1200 },
  ];

  if (actions.length > MAX_STEPS) {
    throw new Error(`Demo action count exceeds max steps (${MAX_STEPS})`);
  }

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

    for (let index = 0; index < actions.length; index += 1) {
      if (await shouldStop(runId)) {
        log.info({ runId }, 'Demo run stopped before next action');
        break;
      }

      const action = actions[index];
      if (!action) {
        throw new Error(`Missing action at index ${index}`);
      }

      await executeAction(page, action);

      if (index === 0) {
        await wait(page, INITIAL_SETTLE_MS);
      } else {
        await wait(page, STEP_SETTLE_MS);
      }

      if (await shouldStop(runId)) {
        log.info({ runId }, 'Demo run stopped after action execution');
        break;
      }

      await captureStep(runId, page, index, action);
      log.info(
        { runId, step: index, actionType: action.type },
        'Captured demo step',
      );
    }

    const latestRunState = await getRun(runId);

    if (!isTerminalStatus(latestRunState.status)) {
      await updateRun(runId, {
        status: 'success',
        updatedAt: Date.now(),
      });
      log.info({ runId }, 'Demo run completed');
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
