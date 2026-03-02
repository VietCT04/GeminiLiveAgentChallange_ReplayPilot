import {
  RunStateSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  type RunState,
} from '@replaypilot/shared';
import { useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from './config';

const terminalStatuses = new Set(['success', 'fail', 'stopped']);
const defaultGoal =
  'Open YouTube, search Adele Hello official music video, open top result, attempt Like. Success if Like toggles on or sign in prompt appears.';

const formatTimestamp = (value: number | undefined): string => {
  if (!value) {
    return 'none yet';
  }

  return new Date(value).toLocaleString();
};

const summarizeAction = (
  runState: RunState['history'][number]['action'],
): string => {
  switch (runState.type) {
    case 'navigate':
      return `Navigate to ${runState.url}`;
    case 'click':
      return `Click at (${runState.x}, ${runState.y})`;
    case 'type':
      return `Type "${runState.text}"`;
    case 'scroll':
      return `Scroll ${runState.deltaY}`;
    case 'wait':
      return `Wait ${runState.ms}ms`;
    case 'done':
      return `Done: ${runState.reason}`;
    default: {
      const exhaustiveCheck: never = runState;
      return JSON.stringify(exhaustiveCheck);
    }
  }
};

function App() {
  const [runId, setRunId] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState | null>(null);
  const [goal, setGoal] = useState(defaultGoal);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const pollTimerRef = useRef<number | null>(null);
  const consecutivePollFailuresRef = useRef(0);

  const stopPolling = (): void => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    consecutivePollFailuresRef.current = 0;
    setIsPolling(false);
  };

  const loadRun = async (nextRunId: string): Promise<void> => {
    setIsPolling(true);
    const response = await fetch(`${API_BASE_URL}/runs/${nextRunId}`);

    if (!response.ok) {
      setIsPolling(false);
      throw new Error(`Failed to load run ${nextRunId}`);
    }

    const payload = RunStateSchema.parse((await response.json()) as unknown);
    consecutivePollFailuresRef.current = 0;
    setRunState(payload);
    setRequestError(null);
    setIsPolling(false);

    if (terminalStatuses.has(payload.status)) {
      stopPolling();
    }
  };

  const startPolling = (nextRunId: string): void => {
    stopPolling();
    pollTimerRef.current = window.setInterval(() => {
      void loadRun(nextRunId).catch((error: unknown) => {
        consecutivePollFailuresRef.current += 1;

        if (consecutivePollFailuresRef.current <= 2) {
          return;
        }

        const message =
          error instanceof Error ? error.message : 'Failed to poll run state';
        setIsPolling(false);
        setRequestError(message);
        stopPolling();
      });
    }, 1000);
  };

  const startRun = async (
    endpointPath: string,
    failureMessage: string,
  ): Promise<void> => {
    stopPolling();
    setRequestError(null);

    try {
      const requestBody = StartRunRequestSchema.parse({
        goal,
      });

      const response = await fetch(`${API_BASE_URL}${endpointPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(failureMessage);
      }

      const payload = StartRunResponseSchema.parse(
        (await response.json()) as unknown,
      );

      setRunId(payload.runId);
      await loadRun(payload.runId);
      startPolling(payload.runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : failureMessage;
      setIsPolling(false);
      setRequestError(message);
    }
  };

  const handleRunClick = async (): Promise<void> => {
    await startRun('/runs', 'Failed to start run');
  };

  const handleComputerUseClick = async (): Promise<void> => {
    await startRun('/runs/computer-use', 'Failed to start computer use run');
  };

  const handleStopClick = async (): Promise<void> => {
    if (!runId) {
      return;
    }

    stopPolling();

    try {
      const response = await fetch(`${API_BASE_URL}/runs/${runId}/stop`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Failed to stop run ${runId}`);
      }

      const payload = RunStateSchema.parse((await response.json()) as unknown);
      setRunState(payload);
      setRequestError(null);
      setIsPolling(false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to stop run';
      setIsPolling(false);
      setRequestError(message);
    }
  };

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, []);

  const isRunning = runState?.status === 'running';
  const isActive = isRunning || isPolling;
  const latestEntry =
    runState && runState.history.length > 0
      ? runState.history[runState.history.length - 1]
      : null;
  const screenshotUrl = runState?.lastScreenshotUrl
    ? `${API_BASE_URL}${runState.lastScreenshotUrl}?t=${runState.updatedAt}`
    : null;

  return (
    <main className="app-shell">
      <section className="control-panel">
        <header className="panel-header">
          <div>
            <p className="eyebrow">Step 3</p>
            <h1>ReplayPilot Controller</h1>
            <p className="subtitle">
              Submit a goal, then monitor step-by-step screenshots and action logs.
            </p>
          </div>
          <div>
            <label className="eyebrow" htmlFor="goal-input">
              Goal
            </label>
            <textarea
              id="goal-input"
              className="json-block"
              rows={3}
              value={goal}
              onChange={(event) => {
                setGoal(event.target.value);
              }}
            />
          </div>
          <div className="button-row">
            <button type="button" onClick={() => void handleRunClick()}>
              Start Run
            </button>
            <button
              type="button"
              onClick={() => void handleComputerUseClick()}
            >
              Start Computer Use
            </button>
            <button
              type="button"
              onClick={() => void handleStopClick()}
              disabled={!isRunning}
            >
              Stop
            </button>
          </div>
        </header>

        <section className="status-grid">
          <div className="status-card">
            <div className="card-title-row">
              <h2>Run State</h2>
              {isActive ? (
                <div className="live-indicator" aria-live="polite">
                  <span className="spinner" aria-hidden="true" />
                  <span>
                    {isRunning ? 'Waiting for next step' : 'Refreshing'}
                  </span>
                </div>
              ) : null}
            </div>
            <dl className="detail-list">
              <div>
                <dt>Goal</dt>
                <dd>{runState?.goal ?? goal}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{runState?.status ?? 'idle'}</dd>
              </div>
              <div>
                <dt>Run ID</dt>
                <dd>{runId ?? 'none yet'}</dd>
              </div>
              <div>
                <dt>Step</dt>
                <dd>{runState?.step ?? 0}</dd>
              </div>
              <div>
                <dt>Updated At</dt>
                <dd>{formatTimestamp(runState?.updatedAt)}</dd>
              </div>
              <div>
                <dt>Last Action</dt>
                <dd>
                  <pre className="json-block">
                    {runState?.lastAction
                      ? JSON.stringify(runState.lastAction, null, 2)
                      : 'none yet'}
                  </pre>
                </dd>
              </div>
              <div>
                <dt>Current Intent</dt>
                <dd>{latestEntry?.note ?? 'none yet'}</dd>
              </div>
              <div>
                <dt>Error</dt>
                <dd>{runState?.error ?? requestError ?? 'none'}</dd>
              </div>
            </dl>
          </div>

          <div className="status-card">
            <div className="card-title-row">
              <h2>Screenshot</h2>
              <span className="step-counter">
                {runState
                  ? `${runState.history.length} logged steps`
                  : '0 logged steps'}
              </span>
            </div>
            {screenshotUrl ? (
              <div className="screenshot-frame">
                <img
                  className="screenshot"
                  src={screenshotUrl}
                  alt="Latest run screenshot"
                />
                {isRunning ? (
                  <div className="screenshot-overlay">
                    <span
                      className="spinner spinner-light"
                      aria-hidden="true"
                    />
                    <span>Running next step...</span>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="empty-state">no screenshot yet</p>
            )}
          </div>
        </section>

        <section className="status-card history-card">
          <div className="card-title-row">
            <h2>Step Log</h2>
            <span className="step-counter">
              {runState?.history.length ?? 0} total entries
            </span>
          </div>
          {runState?.history.length ? (
            <ol className="history-list">
              {runState.history.map((entry) => (
                <li className="history-item" key={`${entry.index}-${entry.ts}`}>
                  <div className="history-topline">
                    <strong>Step {entry.index + 1}</strong>
                    <span>{formatTimestamp(entry.ts)}</span>
                  </div>
                  <p className="history-summary">
                    {entry.note ?? summarizeAction(entry.action)}
                  </p>
                  <pre className="json-block history-json">
                    {JSON.stringify(entry.action, null, 2)}
                  </pre>
                  <p className="history-meta">
                    Screenshot: {entry.screenshotName ?? 'none'}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty-state">No steps recorded yet.</p>
          )}
        </section>
      </section>
    </main>
  );
}

export default App;
  
