import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunEvent, TicketDetail } from '@/lib/types';
import { TicketView } from './ticket';

const fetchTicketMock = vi.fn();
const fetchDraftMock = vi.fn();
const sayInDraftMock = vi.fn();
const acceptDraftMock = vi.fn();
const fetchBoardMock = vi.fn();
const fetchLabelsMock = vi.fn();
const setTicketPriorityMock = vi.fn();
const setTicketLabelsMock = vi.fn();
const addTicketRelationMock = vi.fn();
const removeTicketRelationMock = vi.fn();
const runStreamMock = vi.fn();

vi.mock('@/lib/api', () => ({
  fetchTicket: (...args: unknown[]) => fetchTicketMock(...args),
  fetchDraft: (...args: unknown[]) => fetchDraftMock(...args),
  sayInDraft: (...args: unknown[]) => sayInDraftMock(...args),
  acceptDraft: (...args: unknown[]) => acceptDraftMock(...args),
  fetchBoard: (...args: unknown[]) => fetchBoardMock(...args),
  fetchLabels: (...args: unknown[]) => fetchLabelsMock(...args),
  setTicketPriority: (...args: unknown[]) => setTicketPriorityMock(...args),
  setTicketLabels: (...args: unknown[]) => setTicketLabelsMock(...args),
  addTicketRelation: (...args: unknown[]) => addTicketRelationMock(...args),
  removeTicketRelation: (...args: unknown[]) => removeTicketRelationMock(...args),
  approveTicket: vi.fn(),
  rejectTicket: vi.fn(),
  unblockTicket: vi.fn(),
  runStream: (...args: unknown[]) => runStreamMock(...args),
  eventsUrl: () => '/api/projects/p/events',
}));

class FakeEventSource {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

async function* eventStream(events: RunEvent[]): AsyncGenerator<RunEvent> {
  for (const event of events) yield event;
}

async function* pendingStream(): AsyncGenerator<RunEvent> {
  await new Promise(() => {});
  yield { type: 'log', line: 'unreachable' };
}

beforeEach(() => {
  fetchTicketMock.mockReset();
  fetchDraftMock.mockReset();
  sayInDraftMock.mockReset();
  acceptDraftMock.mockReset();
  fetchBoardMock.mockReset();
  fetchLabelsMock.mockReset();
  setTicketPriorityMock.mockReset();
  setTicketLabelsMock.mockReset();
  addTicketRelationMock.mockReset();
  removeTicketRelationMock.mockReset();
  runStreamMock.mockReset();
  fetchBoardMock.mockResolvedValue({ epics: [], standaloneTickets: [], pipeline: [] });
  fetchLabelsMock.mockResolvedValue([]);
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
});

afterEach(() => {
  cleanup();
});

function draftTicket(overrides: Partial<TicketDetail> = {}): TicketDetail {
  return {
    id: 1,
    key: 'T-1',
    title: 'Original title',
    description: 'Do the thing',
    status: 'DRAFT',
    attempt: 0,
    hasUi: true,
    epicId: null,
    seq: null,
    dependsOn: [],
    feedback: null,
    gate: null,
    priority: 'medium',
    labels: [],
    criteria: [
      { id: 1, idx: 0, text: 'Criterion one', isUi: false, met: false },
      { id: 2, idx: 1, text: 'Criterion two', isUi: false, met: false },
    ],
    transitions: [],
    artifacts: [],
    agentRuns: [],
    unblockRole: null,
    costUsd: 0,
    leadTimeMs: null,
    agentTimeMs: 0,
    running: false,
    runCommand: null,
    appUrl: null,
    relations: [],
    ...overrides,
  } as TicketDetail;
}

describe('TicketView drafting workspace', () => {
  it('shows the drafting workspace in place of the standard layout for a DRAFT ticket', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket());
    fetchDraftMock.mockResolvedValue({ ...draftTicket(), messages: [] });
    render(<TicketView projectId="p" keyId="T-1" />);
    await screen.findByDisplayValue('Original title');
    expect(screen.getByText('PM conversation')).toBeTruthy();
    expect(screen.queryByText('Request')).toBeNull();
  });

  it('renders the standard read-only layout for a non-DRAFT ticket, with no drafting workspace', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket({ status: 'BACKLOG' }));
    render(<TicketView projectId="p" keyId="T-1" />);
    await screen.findByText('Request');
    expect(screen.getByRole('heading', { name: 'Original title' })).toBeTruthy();
    expect(screen.queryByText('PM conversation')).toBeNull();
    expect(screen.queryByPlaceholderText('Ticket title')).toBeNull();
    expect(fetchDraftMock).not.toHaveBeenCalled();
  });

  it('pre-fills the Title and Acceptance criteria fields, and lets the user edit them', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket());
    fetchDraftMock.mockResolvedValue({ ...draftTicket(), messages: [] });
    render(<TicketView projectId="p" keyId="T-1" />);
    const titleInput = (await screen.findByDisplayValue('Original title')) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Edited title' } });
    expect(titleInput.value).toBe('Edited title');
    const criterion = screen.getByDisplayValue('Criterion one') as HTMLTextAreaElement;
    fireEvent.change(criterion, { target: { value: 'Edited criterion' } });
    expect(criterion.value).toBe('Edited criterion');
  });

  it('lets the user add and remove acceptance criteria', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket());
    fetchDraftMock.mockResolvedValue({ ...draftTicket(), messages: [] });
    render(<TicketView projectId="p" keyId="T-1" />);
    await screen.findByDisplayValue('Original title');
    expect(screen.getAllByPlaceholderText('Acceptance criterion')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /add criterion/i }));
    expect(screen.getAllByPlaceholderText('Acceptance criterion')).toHaveLength(3);
    fireEvent.click(screen.getAllByRole('button', { name: /remove criterion/i })[0]!);
    expect(screen.getAllByPlaceholderText('Acceptance criterion')).toHaveLength(2);
  });

  it('renders existing PM conversation messages in chronological order', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket());
    fetchDraftMock.mockResolvedValue({
      ...draftTicket(),
      messages: [
        { id: 1, ticketId: 1, sender: 'pm', text: 'First question', createdAt: '2024-01-01T00:00:00.000Z' },
        { id: 2, ticketId: 1, sender: 'stakeholder', text: 'First answer', createdAt: '2024-01-01T00:01:00.000Z' },
      ],
    });
    render(<TicketView projectId="p" keyId="T-1" />);
    await screen.findByText('First question');
    const bubbles = screen.getAllByText(/First (question|answer)/);
    expect(bubbles.map((b) => b.textContent)).toEqual(['First question', 'First answer']);
  });

  it('appends a submitted reply to the conversation immediately', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket());
    fetchDraftMock.mockResolvedValue({
      ...draftTicket(),
      messages: [{ id: 1, ticketId: 1, sender: 'pm', text: 'What should this cover?', createdAt: '2024-01-01T00:00:00.000Z' }],
    });
    sayInDraftMock.mockReturnValue(new Promise(() => {}));
    render(<TicketView projectId="p" keyId="T-1" />);
    await screen.findByText('What should this cover?');
    const input = screen.getByPlaceholderText('Reply to the PM');
    fireEvent.change(input, { target: { value: 'Here is my reply' } });
    fireEvent.click(screen.getByRole('button', { name: /send reply/i }));
    expect(await screen.findByText('Here is my reply')).toBeTruthy();
  });

  it('renders the Accept button enabled even with unanswered PM questions', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket());
    fetchDraftMock.mockResolvedValue({
      ...draftTicket(),
      messages: [{ id: 1, ticketId: 1, sender: 'pm', text: 'What should this cover?', createdAt: '2024-01-01T00:00:00.000Z' }],
    });
    render(<TicketView projectId="p" keyId="T-1" />);
    await screen.findByText('What should this cover?');
    const acceptButton = screen.getByRole('button', { name: /accept/i }) as HTMLButtonElement;
    expect(acceptButton.disabled).toBe(false);
  });

  it('saves the edited title and criteria and moves the ticket to the approval gate on Accept', async () => {
    let accepted = false;
    fetchTicketMock.mockImplementation(() =>
      Promise.resolve(accepted ? draftTicket({ status: 'AWAIT_APPROVAL', title: 'Accepted title' }) : draftTicket()),
    );
    fetchDraftMock.mockResolvedValue({ ...draftTicket(), messages: [] });
    acceptDraftMock.mockImplementation(() => {
      accepted = true;
      return Promise.resolve(draftTicket({ status: 'AWAIT_APPROVAL', title: 'Accepted title' }));
    });
    render(<TicketView projectId="p" keyId="T-1" />);
    const titleInput = (await screen.findByDisplayValue('Original title')) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Accepted title' } });
    fireEvent.click(screen.getByRole('button', { name: /accept/i }));
    expect(await screen.findByText('Awaiting approval')).toBeTruthy();
    expect(acceptDraftMock).toHaveBeenCalledWith(
      'p',
      'T-1',
      expect.objectContaining({
        title: 'Accepted title',
        criteria: [
          { text: 'Criterion one', isUi: false },
          { text: 'Criterion two', isUi: false },
        ],
      }),
    );
    expect(screen.getByRole('heading', { name: 'Accepted title' })).toBeTruthy();
    expect(screen.queryByText('PM conversation')).toBeNull();
  });
});

function boardTicket(overrides: Partial<TicketDetail> & { id: number; key: string; title: string }): TicketDetail {
  return draftTicket({ status: 'BACKLOG', ...overrides });
}

describe('TicketView priority control', () => {
  it('displays the current priority', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket({ status: 'BACKLOG', priority: 'high' }));
    render(<TicketView projectId="p" keyId="T-1" />);
    const select = (await screen.findByLabelText('Priority')) as HTMLSelectElement;
    expect(select.value).toBe('high');
  });

  it('lets the user change priority and immediately reflects it without a full reload', async () => {
    fetchTicketMock
      .mockResolvedValueOnce(draftTicket({ status: 'BACKLOG', priority: 'medium' }))
      .mockResolvedValueOnce(draftTicket({ status: 'BACKLOG', priority: 'urgent' }));
    setTicketPriorityMock.mockResolvedValue(draftTicket({ status: 'BACKLOG', priority: 'urgent' }));
    render(<TicketView projectId="p" keyId="T-1" />);
    const select = (await screen.findByLabelText('Priority')) as HTMLSelectElement;
    expect(select.value).toBe('medium');
    fireEvent.change(select, { target: { value: 'urgent' } });
    expect(setTicketPriorityMock).toHaveBeenCalledWith('p', 'T-1', 'urgent');
    await waitFor(() => expect(select.value).toBe('urgent'));
  });

  it('shows an error and leaves the prior priority displayed when the save fails', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket({ status: 'BACKLOG', priority: 'medium' }));
    setTicketPriorityMock.mockRejectedValue(new Error('priority save failed'));
    render(<TicketView projectId="p" keyId="T-1" />);
    const select = (await screen.findByLabelText('Priority')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'high' } });
    expect(await screen.findByText('priority save failed')).toBeTruthy();
    expect(select.value).toBe('medium');
  });
});

describe('TicketView agent runs', () => {
  it('shows ERROR status and the idle timeout message for a failed run', async () => {
    fetchTicketMock.mockResolvedValue(
      draftTicket({
        status: 'BACKLOG',
        agentRuns: [
          {
            id: 1,
            role: 'developer',
            runner: 'claude-sdk',
            model: 'claude-opus-4-8',
            status: 'ERROR',
            costUsd: 0.12,
            numTurns: 0,
            durationMs: 900_000,
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            error: 'idle timeout: no activity for 15 minutes',
          },
        ],
      }),
    );
    render(<TicketView projectId="p" keyId="T-1" />);
    expect(await screen.findByText('ERROR')).toBeTruthy();
    expect(screen.getByText('idle timeout: no activity for 15 minutes')).toBeTruthy();
  });
});

describe('TicketView history', () => {
  it('shows each history entry as a relative time with the absolute local time as a tooltip', async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const createdAt = fiveMinutesAgo.toISOString().slice(0, 19).replace('T', ' ');
    fetchTicketMock.mockResolvedValue(
      draftTicket({
        status: 'BACKLOG',
        transitions: [
          { id: 1, fromState: 'BACKLOG', toState: 'READY', role: 'pm', verdict: null, note: null, createdAt },
        ],
      }),
    );
    render(<TicketView projectId="p" keyId="T-1" />);
    await screen.findByText('History');
    const relative = screen.getByText(/^\d+m ago$/);
    expect(relative.getAttribute('title')).toBeTruthy();
    expect(relative.getAttribute('title')).not.toBe(relative.textContent);
    expect(screen.queryByText(createdAt)).toBeNull();
  });
});

describe('TicketView label editor', () => {
  it('displays all labels currently attached to the ticket', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket({ status: 'BACKLOG', labels: ['backend', 'frontend'] }));
    render(<TicketView projectId="p" keyId="T-1" />);
    await screen.findByText('backend');
    expect(screen.getByText('frontend')).toBeTruthy();
  });

  it('lets the user remove an existing label', async () => {
    fetchTicketMock
      .mockResolvedValueOnce(draftTicket({ status: 'BACKLOG', labels: ['backend'] }))
      .mockResolvedValueOnce(draftTicket({ status: 'BACKLOG', labels: [] }));
    setTicketLabelsMock.mockResolvedValue(draftTicket({ status: 'BACKLOG', labels: [] }));
    render(<TicketView projectId="p" keyId="T-1" />);
    await screen.findByText('backend');
    fireEvent.click(screen.getByRole('button', { name: 'Remove label backend' }));
    expect(setTicketLabelsMock).toHaveBeenCalledWith('p', 'T-1', []);
    await screen.findByText('No labels yet.');
  });

  it('offers previously used labels, excluding ones already applied to this ticket', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket({ status: 'BACKLOG', labels: ['backend'] }));
    fetchLabelsMock.mockResolvedValue(['backend', 'frontend', 'chore']);
    render(<TicketView projectId="p" keyId="T-1" />);
    const input = await screen.findByPlaceholderText('Add a label');
    fireEvent.focus(input);
    expect(await screen.findByRole('button', { name: 'frontend' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chore' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'backend' })).toBeNull();
  });

  it('lets the user add a label by typing a new name that has not been used before', async () => {
    fetchTicketMock
      .mockResolvedValueOnce(draftTicket({ status: 'BACKLOG', labels: [] }))
      .mockResolvedValueOnce(draftTicket({ status: 'BACKLOG', labels: ['chore'] }));
    fetchLabelsMock.mockResolvedValue([]);
    setTicketLabelsMock.mockResolvedValue(draftTicket({ status: 'BACKLOG', labels: ['chore'] }));
    render(<TicketView projectId="p" keyId="T-1" />);
    const input = await screen.findByPlaceholderText('Add a label');
    fireEvent.change(input, { target: { value: 'chore' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(setTicketLabelsMock).toHaveBeenCalledWith('p', 'T-1', ['chore']);
    await waitFor(() => expect(screen.getAllByText('chore').length).toBeGreaterThan(0));
  });

  it('rejects a blank label and a duplicate label without adding an entry', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket({ status: 'BACKLOG', labels: ['backend'] }));
    render(<TicketView projectId="p" keyId="T-1" />);
    const input = await screen.findByPlaceholderText('Add a label');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Label cannot be blank')).toBeTruthy();
    expect(setTicketLabelsMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'backend' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('"backend" is already applied to this ticket')).toBeTruthy();
    expect(setTicketLabelsMock).not.toHaveBeenCalled();
  });
});

describe('TicketView relations manager', () => {
  const board = {
    epics: [],
    standaloneTickets: [
      boardTicket({ id: 1, key: 'T-1', title: 'Current ticket' }),
      boardTicket({ id: 2, key: 'T-2', title: 'Second ticket' }),
      boardTicket({ id: 3, key: 'T-3', title: 'Third ticket' }),
    ],
    pipeline: [],
  };
  const relation = { id: 10, ticketId: 1, otherTicketId: 2, relationType: 'blocks' as const, createdAt: '2024-01-01T00:00:00.000Z' };

  it('displays each relation with the related ticket key, title, and relation type', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket({ status: 'BACKLOG', relations: [relation] }));
    fetchBoardMock.mockResolvedValue(board);
    render(<TicketView projectId="p" keyId="T-1" />);
    await screen.findByText('T-2');
    expect(screen.getByText('Second ticket')).toBeTruthy();
    expect(screen.getByText('blocks')).toBeTruthy();
  });

  it('lets the user remove an existing relation', async () => {
    fetchTicketMock
      .mockResolvedValueOnce(draftTicket({ status: 'BACKLOG', relations: [relation] }))
      .mockResolvedValueOnce(draftTicket({ status: 'BACKLOG', relations: [] }));
    fetchBoardMock.mockResolvedValue(board);
    removeTicketRelationMock.mockResolvedValue(draftTicket({ status: 'BACKLOG', relations: [] }));
    render(<TicketView projectId="p" keyId="T-1" />);
    await screen.findByText('T-2');
    fireEvent.click(screen.getByRole('button', { name: 'Remove relation to T-2' }));
    expect(removeTicketRelationMock).toHaveBeenCalledWith('p', 'T-1', 10);
    await screen.findByText('No relations yet.');
  });

  it('narrows the target combobox by typed text and excludes the current ticket', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket({ status: 'BACKLOG', relations: [] }));
    fetchBoardMock.mockResolvedValue(board);
    render(<TicketView projectId="p" keyId="T-1" />);
    const input = await screen.findByLabelText('Target ticket');
    fireEvent.focus(input);
    expect(screen.queryByRole('button', { name: /T-1/ })).toBeNull();
    expect(await screen.findByRole('button', { name: 'T-2 Second ticket' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'T-3 Third ticket' })).toBeTruthy();

    fireEvent.change(input, { target: { value: 'third' } });
    expect(screen.queryByRole('button', { name: 'T-2 Second ticket' })).toBeNull();
    expect(screen.getByRole('button', { name: 'T-3 Third ticket' })).toBeTruthy();
  });

  it('lets the user add a relation by choosing a type and a target from the combobox', async () => {
    fetchTicketMock
      .mockResolvedValueOnce(draftTicket({ status: 'BACKLOG', relations: [] }))
      .mockResolvedValueOnce(draftTicket({ status: 'BACKLOG', relations: [{ ...relation, id: 11, otherTicketId: 3 }] }));
    fetchBoardMock.mockResolvedValue(board);
    addTicketRelationMock.mockResolvedValue({ ...relation, id: 11, otherTicketId: 3 });
    render(<TicketView projectId="p" keyId="T-1" />);
    const input = await screen.findByLabelText('Target ticket');
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole('button', { name: 'T-3 Third ticket' }));
    fireEvent.click(screen.getByRole('button', { name: /add relation/i }));
    expect(addTicketRelationMock).toHaveBeenCalledWith('p', 'T-1', 'blocks', 'T-3');
    await screen.findByText('Third ticket');
  });

  it('rejects adding a relation that already exists in the same way', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket({ status: 'BACKLOG', relations: [relation] }));
    fetchBoardMock.mockResolvedValue(board);
    render(<TicketView projectId="p" keyId="T-1" />);
    const input = await screen.findByLabelText('Target ticket');
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole('button', { name: 'T-2 Second ticket' }));
    fireEvent.click(screen.getByRole('button', { name: /add relation/i }));
    expect(await screen.findByText('Already blocks T-2')).toBeTruthy();
    expect(addTicketRelationMock).not.toHaveBeenCalled();
  });
});

describe('TicketView Land button', () => {
  it('shows a Land button for a Ready to land ticket, with no parked-reason note beside it', async () => {
    fetchTicketMock.mockResolvedValue(
      draftTicket({
        status: 'READY_TO_LAND',
        transitions: [
          { id: 1, fromState: 'UAT', toState: 'READY_TO_LAND', role: 'uat', verdict: 'PASS', note: 'ready to land note', createdAt: '2024-01-01T00:00:00.000Z' },
        ],
      }),
    );
    render(<TicketView projectId="p" keyId="T-1" />);
    const button = await screen.findByRole('button', { name: /land/i });
    expect(button.parentElement?.textContent?.trim()).toBe('Land');
  });

  it('shows a Land button for a Needs integration ticket, with the last transition note beside it', async () => {
    fetchTicketMock.mockResolvedValue(
      draftTicket({
        status: 'NEEDS_INTEGRATION',
        transitions: [
          { id: 1, fromState: 'READY_TO_LAND', toState: 'NEEDS_INTEGRATION', role: 'integration', verdict: 'FAIL', note: 'merging main conflicts', createdAt: '2024-01-01T00:00:00.000Z' },
        ],
      }),
    );
    render(<TicketView projectId="p" keyId="T-1" />);
    const button = await screen.findByRole('button', { name: /land/i });
    expect(button.parentElement?.textContent).toContain('merging main conflicts');
  });

  it('shows no Land button for a ticket in any other status', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket({ status: 'BACKLOG' }));
    render(<TicketView projectId="p" keyId="T-1" />);
    await screen.findByText('Request');
    expect(screen.queryByRole('button', { name: /land/i })).toBeNull();
  });

  it('opens the run panel and streams landing log lines when Land is clicked', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket({ status: 'NEEDS_INTEGRATION', transitions: [] }));
    runStreamMock.mockReturnValue(eventStream([{ type: 'log', line: 'landing EM-1...' }]));
    render(<TicketView projectId="p" keyId="T-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /land/i }));
    expect(runStreamMock).toHaveBeenCalledWith('p', 'tickets', 'T-1', 'land');
    expect(await screen.findByText('landing EM-1...')).toBeTruthy();
  });

  it('disables the Land button while landing is in progress', async () => {
    fetchTicketMock.mockResolvedValue(draftTicket({ status: 'NEEDS_INTEGRATION', transitions: [] }));
    runStreamMock.mockReturnValue(pendingStream());
    render(<TicketView projectId="p" keyId="T-1" />);
    const button = (await screen.findByRole('button', { name: /land/i })) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
  });

  it('updates the ticket to Done, with no manual refresh, when landing succeeds outright', async () => {
    fetchTicketMock
      .mockResolvedValueOnce(draftTicket({ status: 'READY_TO_LAND', transitions: [] }))
      .mockResolvedValueOnce(draftTicket({ status: 'DONE', transitions: [] }));
    runStreamMock.mockReturnValue(eventStream([{ type: 'done', status: 'DONE' }]));
    render(<TicketView projectId="p" keyId="T-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /land/i }));
    expect(await screen.findByText('Done')).toBeTruthy();
    expect(fetchTicketMock).toHaveBeenCalledTimes(2);
  });

  it('shows Needs integration with the new parked reason when landing cannot complete again', async () => {
    fetchTicketMock
      .mockResolvedValueOnce(
        draftTicket({
          status: 'NEEDS_INTEGRATION',
          transitions: [
            { id: 1, fromState: 'READY_TO_LAND', toState: 'NEEDS_INTEGRATION', role: 'integration', verdict: 'FAIL', note: 'first parked reason', createdAt: '2024-01-01T00:00:00.000Z' },
          ],
        }),
      )
      .mockResolvedValueOnce(
        draftTicket({
          status: 'NEEDS_INTEGRATION',
          transitions: [
            { id: 2, fromState: 'READY_TO_LAND', toState: 'NEEDS_INTEGRATION', role: 'integration', verdict: 'FAIL', note: 'second parked reason', createdAt: '2024-01-02T00:00:00.000Z' },
          ],
        }),
      );
    runStreamMock.mockReturnValue(eventStream([{ type: 'done', status: 'NEEDS_INTEGRATION' }]));
    render(<TicketView projectId="p" keyId="T-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /land/i }));
    await waitFor(() => expect(screen.getAllByText('second parked reason').length).toBeGreaterThan(0));
    expect(screen.queryByText('first parked reason')).toBeNull();
    expect(screen.getAllByText('Needs integration').length).toBeGreaterThan(0);
  });
});
