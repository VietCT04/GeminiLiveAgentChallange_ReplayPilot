import {
  GeneratePlanRequestSchema,
  GeneratePlanResponseSchema,
  RunStateSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  type RunState,
} from '@replaypilot/shared';
import { useEffect, useRef, useState } from 'react';
import { API_BASE_URL, USE_ORCHESTRATOR_START } from './config';

const terminalStatuses = new Set(['success', 'fail', 'stopped']);

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: number;
};

type ChatAssistantResponse = {
  assistantMessage: string;
  workflowIntent: boolean;
  workflowGoal?: string;
  workflowReason?: string;
};

type DraftPlan = {
  summary: string;
  steps: string[];
  runMode: 'computer-use';
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
  const [goal, setGoal] = useState('');
  const [planGoal, setPlanGoal] = useState('');
  const [requestError, setRequestError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [draftPlan, setDraftPlan] = useState<DraftPlan | null>(null);
  const [workflowProposal, setWorkflowProposal] = useState<{
    goal: string;
    reason: string;
  } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'intro',
      role: 'system',
      text: 'Chat normally. Ask to build a workflow when you want automation.',
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

  const normalizeDraftPlanSteps = (steps: string[]): string[] => {
    return steps.map((step) => step.trim()).filter((step) => step.length > 0);
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

  const generatePlan = async (
    goalInput: string,
    failureMessage: string,
  ): Promise<void> => {
    setRequestError(null);
    setIsGeneratingPlan(true);

    try {
      const requestBody = GeneratePlanRequestSchema.parse({
        goal: goalInput,
      });

      const response = await fetch(`${API_BASE_URL}/runs/plan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(failureMessage);
      }

      const payload = GeneratePlanResponseSchema.parse(
        (await response.json()) as unknown,
      );

      setDraftPlan({
        summary: payload.summary,
        steps: payload.steps,
        runMode: 'computer-use',
      });
      setPlanGoal(goalInput);
      setWorkflowProposal(null);
      appendMessage(
        'system',
        'Draft plan generated. Review the steps, edit them if needed, then confirm the run.',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : failureMessage;
      setRequestError(message);
      appendMessage('system', message);
    } finally {
      setIsGeneratingPlan(false);
    }
  };

  const startRun = async (): Promise<void> => {
    if (!draftPlan) {
      return;
    }

    const failureMessage = 'Failed to start computer use run';

    stopPolling();
    setRequestError(null);
    setRunState(null);
    setRunId(null);
    setIsStartingRun(true);
    reportedHistoryCountRef.current = 0;
    announcedTerminalStatusRef.current = null;
    announcedErrorRef.current = null;
    announcedHandoffRef.current = null;

    try {
      const approvedPlanSteps = normalizeDraftPlanSteps(draftPlan.steps);
      const requestBody = StartRunRequestSchema.parse({
        goal: planGoal,
        planSteps: approvedPlanSteps,
      });
      const endpointPath =
        USE_ORCHESTRATOR_START
          ? '/runs/orchestrator/start'
          : '/runs/computer-use';

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
      appendMessage(
        'system',
        USE_ORCHESTRATOR_START
          ? `Plan confirmed. Run ${payload.runId} is created in orchestrator mode. Start local executor.`
          : `Plan confirmed. Run ${payload.runId} is starting now.`,
      );
      await loadRun(payload.runId);
      startPolling(payload.runId);
      setDraftPlan(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : failureMessage;
      setIsPolling(false);
      setRequestError(message);
      appendMessage('system', message);
    } finally {
      setIsStartingRun(false);
    }
  };

  const handleSendClick = async (): Promise<void> => {
    const message = goal.trim();

    if (!message) {
      return;
    }

    appendMessage('user', message);
    setGoal('');
    setIsSendingMessage(true);

    try {
      const response = await fetch(`${API_BASE_URL}/runs/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
          history: messages.slice(-8).map((entry) => ({
            role: entry.role,
            text: entry.text,
          })),
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to get assistant response');
      }

      const payload = (await response.json()) as ChatAssistantResponse;
      appendMessage('assistant', payload.assistantMessage);

      if (payload.workflowIntent) {
        setWorkflowProposal({
          goal: payload.workflowGoal?.trim() || message,
          reason:
            payload.workflowReason?.trim() ||
            'The assistant detected workflow intent from your request.',
        });
      } else {
        setWorkflowProposal(null);
      }
    } catch (error) {
      const fallback =
        error instanceof Error ? error.message : 'Failed to process message';
      setRequestError(fallback);
      appendMessage('system', fallback);
    } finally {
      setIsSendingMessage(false);
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
  const isActive =
    isRunning ||
    isPolling ||
    isWaitingForHuman ||
    isGeneratingPlan ||
    isSendingMessage;
  const latestEntry =
    runState && runState.history.length > 0
      ? runState.history[runState.history.length - 1]
      : null;
  const effectivePlanSteps = draftPlan?.steps ?? runState?.planSteps ?? [];
  const completedPlanSteps = Math.min(
    runState?.completedPlanSteps ?? 0,
    runState?.planSteps.length ?? 0,
  );
  const screenshotUrl = runState?.lastScreenshotUrl
    ? `${API_BASE_URL}${runState.lastScreenshotUrl}?t=${runState.updatedAt}`
    : null;

  return (
    <main className="app-shell">
      <header className="app-topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ▶
          </span>
          <span className="brand-text">ReplayPilot Chat</span>
        </div>
        <button type="button" className="help-button">
          ?
        </button>
      </header>
      <section className="controller-layout">
        <aside className="left-sidebar">
          <section className="sidebar-group">
            <p className="sidebar-title">Conversations</p>
            <input
              className="sidebar-search"
              type="text"
              placeholder="Search"
              readOnly
            />
            <ul className="sidebar-list">
              <li className="sidebar-item sidebar-item-active">
                Automate 'Adele' Like <span>(Active)</span>
              </li>
              <li className="sidebar-item">Google Search Test</li>
              <li className="sidebar-item">Product Pricing Macro</li>
            </ul>
            <button type="button" className="sidebar-add">
              + New Chat
            </button>
          </section>
          <section className="sidebar-group">
            <p className="sidebar-title">Saved Workflows</p>
            <ul className="sidebar-list">
              <li className="sidebar-item">YouTube Adele Like (Run/Edit)</li>
              <li className="sidebar-item">Gmail Archive (Run/Edit)</li>
              <li className="sidebar-item">Data Entry Bot (Run/Edit)</li>
              <li className="sidebar-item">import workflow</li>
            </ul>
          </section>
        </aside>
        <section className="chat-panel">
          <header className="chat-header">
            <div>
              <h1>Automate 'Adele' Like</h1>
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
                    : isGeneratingPlan
                      ? 'Drafting Plan'
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
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void handleSendClick();
                }
              }}
              placeholder="Tell ReplayPilot what to do next..."
            />
            {draftPlan ? (
              <section className="plan-editor">
                <div className="plan-header-row">
                  <div>
                    <p className="eyebrow">Draft Plan</p>
                    <p className="plan-summary">{draftPlan.summary}</p>
                  </div>
                  <span className="step-counter">
                    {draftPlan.steps.length} steps
                  </span>
                </div>
                <div className="plan-step-list">
                  {draftPlan.steps.map((step, index) => (
                    <div className="plan-step-row" key={`${index}-${step}`}>
                      <span className="plan-step-index">{index + 1}</span>
                      <textarea
                        className="plan-step-input"
                        rows={2}
                        value={step}
                        onChange={(event) => {
                          setDraftPlan((current) =>
                            current
                              ? {
                                  ...current,
                                  steps: current.steps.map((item, itemIndex) =>
                                    itemIndex === index ? event.target.value : item,
                                  ),
                                }
                              : current,
                          );
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setDraftPlan((current) =>
                            current
                              ? {
                                  ...current,
                                  steps:
                                    current.steps.length > 1
                                      ? current.steps.filter(
                                          (_item, itemIndex) => itemIndex !== index,
                                        )
                                      : current.steps,
                                }
                              : current,
                          );
                        }}
                        disabled={draftPlan.steps.length <= 1}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setDraftPlan((current) =>
                      current
                        ? {
                            ...current,
                            steps: [...current.steps, ''],
                          }
                        : current,
                    );
                  }}
                >
                  Add Step
                </button>
              </section>
            ) : null}
            <div className="button-row">
              <button type="button" onClick={() => void handleSendClick()}>
                Send
              </button>
              <button
                type="button"
                onClick={() => void startRun()}
                disabled={!draftPlan || isStartingRun || isGeneratingPlan || isSendingMessage}
              >
                Confirm Computer Use
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraftPlan(null);
                }}
                disabled={!draftPlan}
              >
                Clear Draft
              </button>
              <button
                type="button"
                onClick={() => void handleResumeClick()}
                disabled={
                  !isWaitingForHuman ||
                  isGeneratingPlan ||
                  isStartingRun ||
                  isSendingMessage
                }
              >
                Resume
              </button>
              <button
                type="button"
                onClick={() => void handleStopClick()}
                disabled={
                  (!isRunning && !isWaitingForHuman) ||
                  isGeneratingPlan ||
                  isStartingRun ||
                  isSendingMessage
                }
              >
                Stop
              </button>
            </div>
          </section>
          {workflowProposal && !draftPlan ? (
            <section className="proposal-card">
              <p className="eyebrow">Workflow Proposal</p>
              <p className="proposal-reason">{workflowProposal.reason}</p>
              <p className="proposal-goal">{workflowProposal.goal}</p>
              <div className="proposal-actions">
                <button
                  type="button"
                  onClick={() =>
                    void generatePlan(
                      workflowProposal.goal,
                      'Failed to generate workflow plan',
                    )
                  }
                  disabled={isGeneratingPlan}
                >
                  Generate Workflow Plan
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWorkflowProposal(null);
                  }}
                >
                  Dismiss
                </button>
              </div>
            </section>
          ) : null}
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
            </dl>
          </section>

          <section className="status-card">
            <div className="card-title-row">
              <h2>Plan Progress</h2>
              <span className="step-counter">
                {effectivePlanSteps.length
                  ? `${Math.min(
                      runState?.completedPlanSteps ?? 0,
                      effectivePlanSteps.length,
                    )}/${effectivePlanSteps.length}`
                  : 'No plan yet'}
              </span>
            </div>
            {effectivePlanSteps.length ? (
              <ol className="plan-progress-list">
                {effectivePlanSteps.map((step, index) => {
                  const isComplete = index < completedPlanSteps;
                  return (
                    <li
                      className={`plan-progress-item ${isComplete ? 'plan-progress-complete' : ''}`}
                      key={`${index}-${step}`}
                    >
                      <span className="plan-progress-marker">
                        {isComplete ? 'Done' : `Step ${index + 1}`}
                      </span>
                      <span>{step}</span>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="empty-state">
                Generate a plan first, then confirm it to start execution.
              </p>
            )}
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
  
