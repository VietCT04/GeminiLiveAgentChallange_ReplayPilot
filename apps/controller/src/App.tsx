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

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: number;
};

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
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'intro',
      role: 'system',
      text: 'Send an instruction to start a run. Progress updates will appear here while processing details stay on the right.',
      timestamp: Date.now(),
    },
  ]);
  const pollTimerRef = useRef<number | null>(null);
  const consecutivePollFailuresRef = useRef(0);
  const reportedHistoryCountRef = useRef(0);
  const announcedTerminalStatusRef = useRef<RunState['status'] | null>(null);
  const announcedErrorRef = useRef<string | null>(null);
  const announcedHandoffRef = useRef<string | null>(null);

  const appendMessage = (
    role: ChatMessage['role'],
    text: string,
    timestamp = Date.now(),
  ): void => {
    setMessages((current) => [
      ...current,
      {
        id: `${timestamp}-${current.length}`,
        role,
        text,
        timestamp,
      },
    ]);
  };

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
    setRunState(null);
    setRunId(null);
    reportedHistoryCountRef.current = 0;
    announcedTerminalStatusRef.current = null;
    announcedErrorRef.current = null;
    announcedHandoffRef.current = null;

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
      appendMessage('user', goal);
      appendMessage(
        'system',
        `Sent to backend. Run ${payload.runId} is starting now.`,
      );
      await loadRun(payload.runId);
      startPolling(payload.runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : failureMessage;
      setIsPolling(false);
      setRequestError(message);
      appendMessage('system', message);
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

  const handleResumeClick = async (): Promise<void> => {
    if (!runId) {
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/runs/${runId}/resume`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Failed to resume run ${runId}`);
      }

      const payload = RunStateSchema.parse((await response.json()) as unknown);
      setRunState(payload);
      setRequestError(null);
      announcedHandoffRef.current = null;
      appendMessage(
        'system',
        'Run resumed. If the CAPTCHA is still visible, solve it first and the agent will pause again.',
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to resume run';
      setRequestError(message);
    }
  };

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, []);

  useEffect(() => {
    if (!runState) {
      return;
    }

    if (runState.history.length > reportedHistoryCountRef.current) {
      const newEntries = runState.history.slice(reportedHistoryCountRef.current);
      newEntries.forEach((entry) => {
        appendMessage(
          'assistant',
          `Step ${entry.index + 1}: ${entry.note ?? summarizeAction(entry.action)}`,
          entry.ts,
        );
      });
      reportedHistoryCountRef.current = runState.history.length;
    }

    if (
      terminalStatuses.has(runState.status) &&
      announcedTerminalStatusRef.current !== runState.status
    ) {
      const completionMessage =
        runState.status === 'success'
          ? 'Run completed successfully.'
          : runState.status === 'fail'
            ? `Run failed${runState.error ? `: ${runState.error}` : '.'}`
            : 'Run stopped.';
      appendMessage('system', completionMessage, runState.updatedAt);
      announcedTerminalStatusRef.current = runState.status;
    }

    if (
      runState.status === 'waiting_for_human' &&
      runState.handoff &&
      announcedHandoffRef.current !== runState.handoff.screenshotUrl
    ) {
      appendMessage(
        'system',
        `CAPTCHA detected. Solve it in the browser, then press Resume. Current page: ${runState.handoff.url}`,
        runState.updatedAt,
      );
      announcedHandoffRef.current = runState.handoff.screenshotUrl ?? 'handoff';
    }

    if (runState.error && announcedErrorRef.current !== runState.error) {
      appendMessage('system', `Error: ${runState.error}`, runState.updatedAt);
      announcedErrorRef.current = runState.error;
    }
  }, [runState]);

  useEffect(() => {
    if (!requestError || announcedErrorRef.current === requestError) {
      return;
    }

    appendMessage('system', `Request error: ${requestError}`);
    announcedErrorRef.current = requestError;
  }, [requestError]);

  const isRunning = runState?.status === 'running';
  const isWaitingForHuman = runState?.status === 'waiting_for_human';
  const isActive = isRunning || isPolling || isWaitingForHuman;
  const latestEntry =
    runState && runState.history.length > 0
      ? runState.history[runState.history.length - 1]
      : null;
  const screenshotUrl = runState?.lastScreenshotUrl
    ? `${API_BASE_URL}${runState.lastScreenshotUrl}?t=${runState.updatedAt}`
    : null;

  return (
    <main className="app-shell">
      <section className="controller-layout">
        <section className="chat-panel">
          <header className="chat-header">
            <div>
              <p className="eyebrow">Step 3</p>
              <h1>ReplayPilot Chat</h1>
              <p className="subtitle">
                Send instructions like a normal chat, and watch execution updates stream into the conversation.
              </p>
            </div>
            {isActive ? (
              <div className="live-indicator" aria-live="polite">
                <span className="spinner" aria-hidden="true" />
                <span>
                  {isRunning
                    ? 'Processing'
                    : isWaitingForHuman
                      ? 'Waiting For Human'
                      : 'Refreshing'}
                </span>
              </div>
            ) : null}
          </header>

          <section className="message-list" aria-label="Chat messages">
            {messages.map((message) => (
              <article
                key={message.id}
                className={`message-bubble message-${message.role}`}
              >
                <p className="message-role">
                  {message.role === 'user'
                    ? 'You'
                    : message.role === 'assistant'
                      ? 'ReplayPilot'
                      : 'System'}
                </p>
                <p className="message-text">{message.text}</p>
                <p className="message-time">
                  {new Date(message.timestamp).toLocaleTimeString()}
                </p>
              </article>
            ))}
          </section>

          <section className="composer-card">
            <label className="eyebrow" htmlFor="goal-input">
              Message
            </label>
            <textarea
              id="goal-input"
              className="composer-input"
              rows={4}
              value={goal}
              onChange={(event) => {
                setGoal(event.target.value);
              }}
              placeholder="Tell ReplayPilot what to do next..."
            />
            <div className="button-row">
              <button type="button" onClick={() => void handleRunClick()}>
                Send
              </button>
              <button
                type="button"
                onClick={() => void handleComputerUseClick()}
              >
                Send Computer Use
              </button>
              <button
                type="button"
                onClick={() => void handleResumeClick()}
                disabled={!isWaitingForHuman}
              >
                Resume
              </button>
              <button
                type="button"
                onClick={() => void handleStopClick()}
                disabled={!isRunning && !isWaitingForHuman}
              >
                Stop
              </button>
            </div>
          </section>
        </section>

        <aside className="status-panel">
          <section className="status-card">
            <div className="card-title-row">
              <h2>Processing Status</h2>
              <span className="step-counter">
                {runState
                  ? `${runState.history.length} updates`
                  : 'Waiting for input'}
              </span>
            </div>
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
                <dt>Updated</dt>
                <dd>{formatTimestamp(runState?.updatedAt)}</dd>
              </div>
              <div>
                <dt>Current Intent</dt>
                <dd>{latestEntry?.note ?? 'none yet'}</dd>
              </div>
              <div>
                <dt>Error</dt>
                <dd>{runState?.error ?? requestError ?? 'none'}</dd>
              </div>
              <div>
                <dt>Handoff</dt>
                <dd>
                  {runState?.handoff
                    ? `${runState.handoff.reason} at ${runState.handoff.url}`
                    : 'none'}
                </dd>
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
            </dl>
          </section>

          <section className="status-card">
            <div className="card-title-row">
              <h2>Latest Screenshot</h2>
              <span className="step-counter">
                {runState?.status ?? 'idle'}
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
              <p className="empty-state">No screenshot yet.</p>
            )}
          </section>
        </aside>
      </section>
    </main>
  );
}

export default App;
  
