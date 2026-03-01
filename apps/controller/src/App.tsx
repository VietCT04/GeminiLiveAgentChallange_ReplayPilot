import {
  RunStateSchema,
  StartRunResponseSchema,
  type RunState,
} from '@replaypilot/shared';
import { useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from './config';

const terminalStatuses = new Set(['success', 'fail', 'stopped']);

const formatTimestamp = (value: number | undefined): string => {
  if (!value) {
    return 'none yet';
  }

  return new Date(value).toLocaleString();
};

function App() {
  const [runId, setRunId] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const stopPolling = (): void => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const loadRun = async (nextRunId: string): Promise<void> => {
    const response = await fetch(`${API_BASE_URL}/runs/${nextRunId}`);

    if (!response.ok) {
      throw new Error(`Failed to load run ${nextRunId}`);
    }

    const payload = RunStateSchema.parse((await response.json()) as unknown);
    setRunState(payload);
    setRequestError(null);

    if (terminalStatuses.has(payload.status)) {
      stopPolling();
    }
  };

  const startPolling = (nextRunId: string): void => {
    stopPolling();
    pollTimerRef.current = window.setInterval(() => {
      void loadRun(nextRunId).catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : 'Failed to poll run state';
        setRequestError(message);
        stopPolling();
      });
    }, 1000);
  };

  const handleRunClick = async (): Promise<void> => {
    stopPolling();
    setRequestError(null);

    try {
      const response = await fetch(`${API_BASE_URL}/runs/demo`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to start demo run');
      }

      const payload = StartRunResponseSchema.parse(
        (await response.json()) as unknown,
      );

      setRunId(payload.runId);
      await loadRun(payload.runId);
      startPolling(payload.runId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to start demo run';
      setRequestError(message);
    }
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
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to stop run';
      setRequestError(message);
    }
  };

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, []);

  const isRunning = runState?.status === 'running';
  const screenshotUrl = runState?.lastScreenshotUrl
    ? `${API_BASE_URL}${runState.lastScreenshotUrl}`
    : null;

  return (
    <main className="app-shell">
      <section className="control-panel">
        <header className="panel-header">
          <div>
            <p className="eyebrow">Step 3</p>
            <h1>ReplayPilot Controller</h1>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => void handleRunClick()}>
              Run YouTube MV Demo
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
            <h2>Run State</h2>
            <dl className="detail-list">
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
                <dt>Error</dt>
                <dd>{runState?.error ?? requestError ?? 'none'}</dd>
              </div>
            </dl>
          </div>

          <div className="status-card">
            <h2>Screenshot</h2>
            {screenshotUrl ? (
              <img
                className="screenshot"
                src={screenshotUrl}
                alt="Latest run screenshot"
              />
            ) : (
              <p className="empty-state">no screenshot yet</p>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
