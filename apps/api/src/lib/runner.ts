import {
  type Action,
  type HumanHandoffReason,
  type RunState,
  type StepRecord,
} from '@replaypilot/shared';
import { chromium, type Browser, type Page } from 'playwright';
import {
  evaluateStep,
  requiresSafetyConfirmation,
  type JudgeEvaluation,
} from '../observer/judgePipeline';
import {
  planComputerUseStepDetailed,
  planNextActionDetailed,
  type ComputerUseToolCall,
} from '../planner/geminiPlanner';
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
const DEFAULT_START_URL = 'https://www.google.com/';
const VIEWPORT = {
  width: 1280,
  height: 720,
};

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

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const normalizeToolCall = (
  toolCall: ComputerUseToolCall,
): ComputerUseToolCall => {
  const lowerName = (toolCall.name ?? '').toLowerCase();
  const waitSecondsMatch = lowerName.match(/^wait_(\d+)_seconds?$/);

  if (waitSecondsMatch?.[1]) {
    return {
      ...toolCall,
      name: 'wait',
      args: {
        ...(toolCall.args ?? {}),
        seconds: Number(waitSecondsMatch[1]),
      },
    };
  }

  switch (lowerName) {
    case 'open_browser':
    case 'launch_browser':
      return {
        ...toolCall,
        name: 'open_web_browser',
      };
    case 'go_to':
    case 'goto':
    case 'open_url':
      return {
        ...toolCall,
        name: 'navigate',
      };
    case 'left_click':
    case 'single_click':
    case 'click_element':
      return {
        ...toolCall,
        name: 'click',
      };
    case 'double_click':
      return {
        ...toolCall,
        name: 'click',
        args: {
          ...(toolCall.args ?? {}),
          clicks: 2,
        },
      };
    case 'right_click':
      return {
        ...toolCall,
        name: 'click',
        args: {
          ...(toolCall.args ?? {}),
          button: 'right',
        },
      };
    case 'type_into':
    case 'enter_text':
    case 'input_text':
      return {
        ...toolCall,
        name: 'type',
      };
    case 'press_enter':
    case 'hit_enter':
      return {
        ...toolCall,
        name: 'press_key',
        args: {
          ...(toolCall.args ?? {}),
          key: 'Enter',
        },
      };
    case 'scroll_down':
      return {
        ...toolCall,
        name: 'scroll',
        args: {
          ...(toolCall.args ?? {}),
          deltaY: 600,
        },
      };
    case 'scroll_up':
      return {
        ...toolCall,
        name: 'scroll',
        args: {
          ...(toolCall.args ?? {}),
          deltaY: -600,
        },
      };
    default:
      return {
        ...toolCall,
        name: lowerName,
      };
  }
};

const denormalizeCoordinate = (
  value: number,
  size: number,
): number => {
  const scaled = Math.floor((value / 1000) * size);
  const max = size - 1;
  return Math.min(Math.max(scaled, 0), max);
};

const getActionPoint = (
  action: Action,
): { x: number; y: number } | null => {
  if (action.type === 'click') {
    return {
      x: action.x,
      y: action.y,
    };
  }

  if (
    action.type === 'type' &&
    typeof action.x === 'number' &&
    typeof action.y === 'number'
  ) {
    return {
      x: action.x,
      y: action.y,
    };
  }

  return null;
};

const showActionMarker = async (
  page: Page,
  action: Action,
): Promise<void> => {
  const point = getActionPoint(action);

  if (!point) {
    return;
  }

  await page.evaluate(
    ({ x, y }) => {
      const existing = document.getElementById('replaypilot-action-marker');

      if (existing) {
        existing.remove();
      }

      const marker = document.createElement('div');
      marker.id = 'replaypilot-action-marker';
      marker.setAttribute('aria-hidden', 'true');
      marker.style.position = 'fixed';
      marker.style.left = `${x}px`;
      marker.style.top = `${y}px`;
      marker.style.width = '24px';
      marker.style.height = '24px';
      marker.style.marginLeft = '-12px';
      marker.style.marginTop = '-12px';
      marker.style.border = '3px solid #ff2d20';
      marker.style.borderRadius = '999px';
      marker.style.background = 'rgba(255, 45, 32, 0.18)';
      marker.style.boxShadow = '0 0 0 4px rgba(255, 45, 32, 0.28)';
      marker.style.pointerEvents = 'none';
      marker.style.zIndex = '2147483647';
      document.body.appendChild(marker);
    },
    point,
  );
};

const hideActionMarker = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    document.getElementById('replaypilot-action-marker')?.remove();
  });
};

const isTerminalStatus = (status: RunState['status']): boolean => {
  return status === 'success' || status === 'fail' || status === 'stopped';
};

const shouldStop = async (runId: string): Promise<boolean> => {
  const runState = await getRun(runId);
  return runState.status === 'stopped';
};

const ensureAllowedNavigateUrl = (urlValue: string): void => {
  let url: URL;

  try {
    url = new URL(urlValue);
  } catch {
    throw new Error(`Planner returned invalid navigation URL: ${urlValue}`);
  }

  if (!allowedNavigationHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`Blocked navigation host from planner: ${url.hostname}`);
  }
};

const ensureAllowedNavigate = (action: Action): void => {
  if (action.type !== 'navigate') {
    return;
  }

  ensureAllowedNavigateUrl(action.url);
};

const ensureCoordinatesInViewport = (action: Action): void => {
  if (action.type === 'click') {
    const { x, y } = action;

    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= VIEWPORT.width ||
      y >= VIEWPORT.height
    ) {
      throw new Error(
        `Planner returned off-screen click coordinates: (${x}, ${y}) for viewport ${VIEWPORT.width}x${VIEWPORT.height}`,
      );
    }
  }

  if (
    action.type === 'type' &&
    typeof action.x === 'number' &&
    typeof action.y === 'number'
  ) {
    const { x, y } = action;

    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= VIEWPORT.width ||
      y >= VIEWPORT.height
    ) {
      throw new Error(
        `Planner returned off-screen type coordinates: (${x}, ${y}) for viewport ${VIEWPORT.width}x${VIEWPORT.height}`,
      );
    }
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

const extractToolCallPoint = (
  toolCall: ComputerUseToolCall,
): { x: number; y: number } | null => {
  const args = toolCall.args ?? {};
  const point =
    (typeof args.coordinate === 'object' && args.coordinate !== null
      ? (args.coordinate as Record<string, unknown>)
      : null) ??
    (typeof args.coordinates === 'object' && args.coordinates !== null
      ? (args.coordinates as Record<string, unknown>)
      : null) ??
    (typeof args.position === 'object' && args.position !== null
      ? (args.position as Record<string, unknown>)
      : null) ??
    (typeof args.point === 'object' && args.point !== null
      ? (args.point as Record<string, unknown>)
      : null);
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
    x: denormalizeCoordinate(x, VIEWPORT.width),
    y: denormalizeCoordinate(y, VIEWPORT.height),
  };
};

const toLoggedActionForComputerUse = (
  _toolCall: ComputerUseToolCall,
  actionPreview: Action,
): Action => {
  return actionPreview;
};

const executeComputerUseToolCall = async (
  page: Page,
  goal: string,
  toolCall: ComputerUseToolCall,
): Promise<void> => {
  const normalizedToolCall = normalizeToolCall(toolCall);
  const name = (normalizedToolCall.name ?? '').toLowerCase();
  const args = normalizedToolCall.args ?? {};

  switch (name) {
    case 'open_web_browser':
    case 'navigate': {
      const url =
        (typeof args.url === 'string' ? args.url : null) ??
        (typeof args.uri === 'string' ? args.uri : null) ??
        (goal.toLowerCase().includes('youtube') ? 'https://www.youtube.com/' : null);

      if (!url) {
        await wait(page, 250);
        return;
      }

      ensureAllowedNavigateUrl(url);
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      return;
    }
    case 'click_at':
    case 'click': {
      const point = extractToolCallPoint(toolCall);

      if (!point) {
        throw new Error(`Computer Use tool call ${toolCall.name ?? 'unknown'} did not include click coordinates`);
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
        throw new Error(`Computer Use tool call ${toolCall.name ?? 'unknown'} did not include text`);
      }

      const point = extractToolCallPoint(toolCall);

      if (point) {
        await page.mouse.click(point.x, point.y);
      }

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
        throw new Error(`Computer Use tool call ${toolCall.name ?? 'unknown'} did not include a key`);
      }

      await page.keyboard.press(key);
      return;
    }
    case 'scroll_by':
    case 'scroll': {
      const deltaY =
        typeof args.deltaY === 'number'
          ? args.deltaY
          : typeof args.delta_y === 'number'
            ? args.delta_y
            : typeof args.amount === 'number'
              ? args.amount
              : typeof args.y === 'number'
                ? args.y
                : null;

      if (deltaY === null) {
        throw new Error(`Computer Use tool call ${toolCall.name ?? 'unknown'} did not include a scroll delta`);
      }

      await page.mouse.wheel(0, deltaY);
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
              : null;

      if (ms === null) {
        throw new Error(`Computer Use tool call ${toolCall.name ?? 'unknown'} did not include a wait duration`);
      }

      await wait(page, Math.max(0, Math.round(ms)));
      return;
    }
    default:
      throw new Error(`Unsupported Computer Use tool call: ${toolCall.name ?? 'unknown'}`);
  }
};

const captureActionStep = async (
  runId: string,
  page: Page,
  index: number,
  action: Action,
  note: string,
): Promise<void> => {
  const screenshotName = formatStepFileName('step', index, 'png');
  const screenshotPath = resolveArtifactPath(runId, screenshotName);

  await showActionMarker(page, action);

  try {
    await page.screenshot({
      path: screenshotPath,
      fullPage: false,
    });
  } finally {
    await hideActionMarker(page);
  }

  await appendHistory(runId, {
    index,
    ts: Date.now(),
    action,
    screenshotName,
    note,
  });

  await updateRun(runId, {
    status: 'running',
    step: index + 1,
    lastAction: action,
    lastScreenshotUrl: `/runs/${runId}/artifacts/${screenshotName}`,
    updatedAt: Date.now(),
  });
};

const initializeDefaultStartPage = async (
  runId: string,
  page: Page,
): Promise<number> => {
  const action: Action = {
    type: 'navigate',
    url: DEFAULT_START_URL,
  };

  await page.goto(DEFAULT_START_URL, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  await wait(page, STEP_SETTLE_MS);
  await captureActionStep(
    runId,
    page,
    0,
    action,
    'Opened Google automatically as the start page',
  );

  return 1;
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

const detectCaptchaReason = async (page: Page): Promise<string | null> => {
  const frameHasCaptcha = page.frames().some((frame) => {
    const url = frame.url().toLowerCase();
    return url.includes('recaptcha') || url.includes('hcaptcha');
  });

  if (frameHasCaptcha) {
    return 'captcha frame detected';
  }

  const pageSignals = await page.evaluate(() => {
    const selectorMatches = [
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      '.g-recaptcha',
      '.h-captcha',
      '[id*="captcha" i]',
      '[class*="captcha" i]',
      '[name*="captcha" i]',
      '[title*="captcha" i]',
    ].some((selector) => document.querySelector(selector) !== null);
    const bodyText = document.body?.innerText?.toLowerCase() ?? '';
    const textMatches =
      bodyText.includes("i'm not a robot") ||
      bodyText.includes('im not a robot') ||
      bodyText.includes('verify you are human') ||
      bodyText.includes('verify that you are human') ||
      bodyText.includes('complete the captcha') ||
      bodyText.includes('security check') ||
      bodyText.includes('captcha');

    return {
      selectorMatches,
      textMatches,
    };
  });

  if (pageSignals.selectorMatches) {
    return 'captcha selector detected';
  }

  if (pageSignals.textMatches) {
    return 'captcha challenge text detected';
  }

  return null;
};

const waitForRunResume = async (
  runId: string,
): Promise<'running' | 'stopped'> => {
  for (;;) {
    const runState = await getRun(runId);

    if (runState.status === 'running') {
      return 'running';
    }

    if (runState.status === 'stopped') {
      return 'stopped';
    }

    await sleep(1000);
  }
};

const pauseForHumanHandoff = async (
  runId: string,
  page: Page,
  log: { info: (context: object, message: string) => void },
  reason: HumanHandoffReason,
  details: string,
): Promise<boolean> => {
  const handoffScreenshotName = `handoff_${reason.toLowerCase()}_${Date.now()}.png`;
  const handoffScreenshotPath = resolveArtifactPath(runId, handoffScreenshotName);
  await page.screenshot({
    path: handoffScreenshotPath,
    fullPage: false,
  });

  const screenshotUrl = `/runs/${runId}/artifacts/${handoffScreenshotName}`;
  await updateRun(runId, {
    status: 'waiting_for_human',
    updatedAt: Date.now(),
    lastScreenshotUrl: screenshotUrl,
    handoff: {
      reason,
      url: page.url(),
      screenshotUrl,
    },
  });
  log.info({ runId, reason, details, url: page.url() }, 'Paused run for human handoff');

  const resumeStatus = await waitForRunResume(runId);

  if (resumeStatus === 'stopped') {
    log.info({ runId }, 'Run stopped during human handoff');
    return true;
  }

  return false;
};

const pauseForCaptchaIfDetected = async (
  runId: string,
  page: Page,
  log: { info: (context: object, message: string) => void },
): Promise<boolean> => {
  for (;;) {
    const reason = await detectCaptchaReason(page);

    if (!reason) {
      return false;
    }

    const shouldStop = await pauseForHumanHandoff(
      runId,
      page,
      log,
      'CAPTCHA_DETECTED',
      reason,
    );

    if (shouldStop) {
      return true;
    }
  }
};

const writeJudgeDebugFile = async (
  runId: string,
  index: number,
  evaluation: JudgeEvaluation,
): Promise<void> => {
  await writeArtifactJson(
    runId,
    formatStepFileName('judge', index, 'json'),
    evaluation,
  );
};

const getCurrentPlanCriteria = (runState: RunState): string => {
  if (!runState.planSteps.length) {
    return runState.goal;
  }

  const currentStepIndex = Math.min(
    runState.completedPlanSteps,
    runState.planSteps.length - 1,
  );

  return runState.planSteps[currentStepIndex] ?? runState.goal;
};

const evaluateAndApplyJudge = async (
  runId: string,
  page: Page,
  currentRun: RunState,
  index: number,
  log: { info: (context: object, message: string) => void },
  previousUrl: string | null,
  previousScreenshotHash: string | null,
): Promise<{
  stopRun: boolean;
  nextPreviousUrl: string;
  nextPreviousScreenshotHash: string;
}> => {
  const currentUrl = page.url();
  const screenshotBytes = await page.screenshot({
    fullPage: false,
  });
  const evaluation = await evaluateStep({
    goal: currentRun.goal,
    stepIndex: currentRun.completedPlanSteps,
    stepCriteria: getCurrentPlanCriteria(currentRun),
    currentUrl,
    previousUrl,
    screenshotBytes,
    previousScreenshotHash,
  });

  await writeJudgeDebugFile(runId, index, evaluation);

  if (evaluation.verdict === 'WAITING_FOR_HUMAN') {
    const shouldStop = await pauseForHumanHandoff(
      runId,
      page,
      log,
      evaluation.handoffReason ?? 'CAPTCHA_DETECTED',
      evaluation.reasonsUi.join('; '),
    );

    return {
      stopRun: shouldStop,
      nextPreviousUrl: page.url(),
      nextPreviousScreenshotHash: evaluation.screenshotHash,
    };
  }

  if (evaluation.verdict === 'FAIL') {
    throw new Error(`Judge failed step: ${evaluation.reasonsUi.join('; ')}`);
  }

  if (
    evaluation.verdict === 'PASS' &&
    currentRun.planSteps.length > 0 &&
    currentRun.completedPlanSteps < currentRun.planSteps.length
  ) {
    await updateRun(runId, {
      completedPlanSteps: currentRun.completedPlanSteps + 1,
      approvedSafetyStep:
        currentRun.approvedSafetyStep === getCurrentPlanCriteria(currentRun)
          ? undefined
          : currentRun.approvedSafetyStep,
      updatedAt: Date.now(),
    });
  }

  log.info(
    {
      runId,
      step: index,
      verdict: evaluation.verdict,
      screenshotChanged: evaluation.screenshotChanged,
      urlChanged: evaluation.urlChanged,
    },
    'Judge evaluated current step',
  );

  return {
    stopRun: false,
    nextPreviousUrl: currentUrl,
    nextPreviousScreenshotHash: evaluation.screenshotHash,
  };
};

const pauseForSafetyConfirmationIfNeeded = async (
  runId: string,
  page: Page,
  currentRun: RunState,
  log: { info: (context: object, message: string) => void },
): Promise<boolean> => {
  const stepCriteria = getCurrentPlanCriteria(currentRun);

  if (!requiresSafetyConfirmation(stepCriteria)) {
    return false;
  }

  if (currentRun.approvedSafetyStep === stepCriteria) {
    return false;
  }

  return pauseForHumanHandoff(
    runId,
    page,
    log,
    'SAFETY_CONFIRMATION_PENDING',
    `Safety confirmation required for plan step: ${stepCriteria}`,
  );
};

export const runSequence = async (
  runId: string,
  log: { info: (context: object, message: string) => void },
): Promise<void> => {
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      viewport: VIEWPORT,
    });
    const page = await context.newPage();
    const startIndex = await initializeDefaultStartPage(runId, page);
    let previousUrl: string | null = page.url();
    let previousScreenshotHash: string | null = null;

    for (let index = startIndex; index < MAX_STEPS; index += 1) {
      if (await shouldStop(runId)) {
        log.info({ runId }, 'Run stopped before planning next action');
        break;
      }

      if (await pauseForCaptchaIfDetected(runId, page, log)) {
        break;
      }

      const currentRun = await getRun(runId);

      if (await pauseForSafetyConfirmationIfNeeded(runId, page, currentRun, log)) {
        break;
      }

      const plannerScreenshot = await page.screenshot({
        fullPage: false,
      });

      const { action, summary, debug } = await planNextActionDetailed(
        currentRun.goal,
        plannerScreenshot,
        currentRun.history,
        VIEWPORT,
        {
          verifierLowConfidenceStreak: 0,
        },
      );

      await writePlannerDebugFiles(runId, index, debug);
      ensureAllowedNavigate(action);
      ensureCoordinatesInViewport(action);
      ensureNoLoop(currentRun.history, action);

      if (action.type === 'done') {
        await appendHistory(runId, {
          index,
          ts: Date.now(),
          action,
          note: summary,
        });
        await updateRun(runId, {
          status: 'success',
          step: index + 1,
          lastAction: action,
          updatedAt: Date.now(),
        });
        log.info({ runId, step: index, reason: action.reason }, 'Run done');
        break;
      }

      await executeAction(page, action);
      await wait(page, STEP_SETTLE_MS);

      if (await shouldStop(runId)) {
        log.info({ runId }, 'Run stopped after action execution');
        break;
      }

      await captureActionStep(runId, page, index, action, summary);
      const judgeResult = await evaluateAndApplyJudge(
        runId,
        page,
        currentRun,
        index,
        log,
        previousUrl,
        previousScreenshotHash,
      );
      previousUrl = judgeResult.nextPreviousUrl;
      previousScreenshotHash = judgeResult.nextPreviousScreenshotHash;

      if (judgeResult.stopRun) {
        break;
      }

      log.info(
        { runId, step: index, actionType: action.type },
        'Captured run step',
      );
    }

    const latestRunState = await getRun(runId);

    if (!isTerminalStatus(latestRunState.status)) {
      throw new Error(`Planner reached max steps (${MAX_STEPS}) without finishing`);
    }
  } catch (error) {
    await updateRun(runId, {
      status: 'fail',
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : 'Run execution failed',
    });
    throw error;
  }
};

export const runComputerUseSequence = async (
  runId: string,
  log: { info: (context: object, message: string) => void },
): Promise<void> => {
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      viewport: VIEWPORT,
    });
    const page = await context.newPage();
    const startIndex = await initializeDefaultStartPage(runId, page);
    let previousUrl: string | null = page.url();
    let previousScreenshotHash: string | null = null;

    for (let index = startIndex; index < MAX_STEPS; index += 1) {
      if (await shouldStop(runId)) {
        log.info({ runId }, 'Computer Use run stopped before planning next action');
        break;
      }

      if (await pauseForCaptchaIfDetected(runId, page, log)) {
        break;
      }

      const currentRun = await getRun(runId);

      if (await pauseForSafetyConfirmationIfNeeded(runId, page, currentRun, log)) {
        break;
      }

      const plannerScreenshot = await page.screenshot({
        fullPage: false,
      });
      const {
        toolCall,
        actionPreview,
        summary,
        debug,
      } = await planComputerUseStepDetailed(
        currentRun.goal,
        plannerScreenshot,
        currentRun.history,
        VIEWPORT,
        {
          verifierLowConfidenceStreak: 0,
        },
      );

      await writePlannerDebugFiles(runId, index, debug);
      const loggedAction = toolCall
        ? toLoggedActionForComputerUse(toolCall, actionPreview)
        : actionPreview;
      ensureNoLoop(currentRun.history, loggedAction);

      if (loggedAction.type === 'done') {
        await appendHistory(runId, {
          index,
          ts: Date.now(),
          action: loggedAction,
          note: summary,
        });
        await updateRun(runId, {
          status: 'success',
          step: index + 1,
          lastAction: loggedAction,
          updatedAt: Date.now(),
        });
        log.info({ runId, step: index, reason: loggedAction.reason }, 'Computer Use run done');
        break;
      }

      if (!toolCall) {
        throw new Error('Computer Use planner did not return a tool call');
      }

      await executeComputerUseToolCall(page, currentRun.goal, toolCall);
      await wait(page, STEP_SETTLE_MS);

      if (await shouldStop(runId)) {
        log.info({ runId }, 'Computer Use run stopped after tool execution');
        break;
      }

      await captureActionStep(runId, page, index, loggedAction, summary);
      const judgeResult = await evaluateAndApplyJudge(
        runId,
        page,
        currentRun,
        index,
        log,
        previousUrl,
        previousScreenshotHash,
      );
      previousUrl = judgeResult.nextPreviousUrl;
      previousScreenshotHash = judgeResult.nextPreviousScreenshotHash;

      if (judgeResult.stopRun) {
        break;
      }

      log.info(
        { runId, step: index, toolCall: toolCall.name ?? 'unknown' },
        'Captured computer use step',
      );
    }

    const latestRunState = await getRun(runId);

    if (!isTerminalStatus(latestRunState.status)) {
      throw new Error(`Planner reached max steps (${MAX_STEPS}) without finishing`);
    }
  } catch (error) {
    await updateRun(runId, {
      status: 'fail',
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : 'Computer Use run execution failed',
    });
    throw error;
  } finally {
    await browser?.close();
  }
};
