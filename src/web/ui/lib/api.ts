import type {
  BoardData,
  ConfigResponse,
  EpicDetail,
  Report,
  RunEvent,
  Ticket,
  TicketDetail,
  TicketRelation,
  TicketRelationType,
} from './types';

export interface ProjectEntry {
  id: string;
  name: string;
  root: string;
}

function base(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.json() as Promise<T>;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body && typeof body.error === 'string') return body.error;
  } catch {
    /* fall through */
  }
  return fallback;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await errorMessage(res, `${url} failed with ${res.status}`));
  return res.json() as Promise<T>;
}

async function putJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await errorMessage(res, `${url} failed with ${res.status}`));
  return res.json() as Promise<T>;
}

async function deleteJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(await errorMessage(res, `${url} failed with ${res.status}`));
  return res.json() as Promise<T>;
}

export const fetchProjects = () => getJson<{ projects: ProjectEntry[] }>('/api/projects').then((r) => r.projects);

export const fetchBoard = (pid: string) => getJson<BoardData>(`${base(pid)}/board`);
export const fetchTicket = (pid: string, key: string) => getJson<TicketDetail>(`${base(pid)}/tickets/${encodeURIComponent(key)}`);
export const fetchEpic = (pid: string, key: string) => getJson<EpicDetail>(`${base(pid)}/epics/${encodeURIComponent(key)}`);

export interface DraftMessageEntry {
  id: number;
  ticketId: number;
  sender: 'stakeholder' | 'pm';
  text: string;
  createdAt: string;
}
export type DraftConversation = Ticket & { messages: DraftMessageEntry[] };
export const fetchDraft = (pid: string, key: string) =>
  getJson<DraftConversation>(`${base(pid)}/tickets/${encodeURIComponent(key)}/draft`);
export const sayInDraft = (pid: string, key: string, text: string) =>
  postJson<{ reply: DraftMessageEntry }>(`${base(pid)}/tickets/${encodeURIComponent(key)}/draft/say`, { text });
export const acceptDraft = (
  pid: string,
  key: string,
  body: {
    title: string;
    description: string;
    criteria: { text: string; isUi: boolean }[];
    hasUi: boolean;
    runCommand: string | null;
    appUrl: string | null;
  },
) => postJson<TicketDetail>(`${base(pid)}/tickets/${encodeURIComponent(key)}/draft/accept`, body);
export const fetchConfig = (pid: string) => getJson<ConfigResponse>(`${base(pid)}/config`);
export const fetchReport = (pid: string, days: number | 'all') => getJson<Report>(`${base(pid)}/report?days=${days}`);

export interface ModelListing {
  provider: string;
  id: string;
  inputPer1M: number | null;
  outputPer1M: number | null;
}
export const fetchModels = (pid: string) => getJson<{ models: ModelListing[] }>(`${base(pid)}/models`).then((r) => r.models);

export interface ImageAttachment {
  name: string;
  mime: string;
  dataBase64: string;
}
export const createTicket = (pid: string, description: string, images: ImageAttachment[] = []) =>
  postJson<{ key: string }>(`${base(pid)}/tickets`, { description, images });
export const createDraftTicket = (pid: string, idea: string, images: ImageAttachment[] = []) =>
  postJson<{ key: string }>(`${base(pid)}/tickets/draft`, { idea, images });
export const createEpic = (pid: string, goal: string) => postJson<{ key: string }>(`${base(pid)}/epics`, { goal });
export const approveTicket = (pid: string, key: string) => postJson(`${base(pid)}/tickets/${encodeURIComponent(key)}/approve`);
export const rejectTicket = (pid: string, key: string, feedback: string) =>
  postJson(`${base(pid)}/tickets/${encodeURIComponent(key)}/reject`, { feedback });
export const unblockTicket = (pid: string, key: string, guidance: string) =>
  postJson(`${base(pid)}/tickets/${encodeURIComponent(key)}/unblock`, { guidance });
export const fetchLabels = (pid: string) => getJson<{ labels: string[] }>(`${base(pid)}/labels`).then((r) => r.labels);
export const setTicketPriority = (pid: string, key: string, priority: string) =>
  putJson<TicketDetail>(`${base(pid)}/tickets/${encodeURIComponent(key)}/priority`, { priority });
export const setTicketLabels = (pid: string, key: string, labels: string[]) =>
  putJson<TicketDetail>(`${base(pid)}/tickets/${encodeURIComponent(key)}/labels`, { labels });
export const addTicketRelation = (pid: string, key: string, type: TicketRelationType, targetKey: string) =>
  postJson<TicketRelation>(`${base(pid)}/tickets/${encodeURIComponent(key)}/relations`, { type, targetKey });
export const removeTicketRelation = (pid: string, key: string, relationId: number) =>
  deleteJson<TicketDetail>(`${base(pid)}/tickets/${encodeURIComponent(key)}/relations/${relationId}`);
export const approveEpic = (pid: string, key: string) => postJson(`${base(pid)}/epics/${encodeURIComponent(key)}/approve`);
export const rejectEpic = (pid: string, key: string, feedback: string) =>
  postJson(`${base(pid)}/epics/${encodeURIComponent(key)}/reject`, { feedback });
export const cancelRun = (pid: string, kind: 'tickets' | 'epics', key: string) =>
  fetch(`${base(pid)}/${kind}/${encodeURIComponent(key)}/cancel`, { method: 'POST' });

export function eventsUrl(pid: string): string {
  return `${base(pid)}/events`;
}
export function logUrl(pid: string, kind: 'tickets' | 'epics', key: string): string {
  return `${base(pid)}/${kind}/${encodeURIComponent(key)}/log`;
}

export async function saveConfig(pid: string, config: unknown): Promise<void> {
  const res = await fetch(`${base(pid)}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `saving config failed with ${res.status}`));
}

export async function* runStream(
  pid: string,
  kind: 'tickets' | 'epics',
  key: string,
  action: 'run' | 'plan' | 'land',
): AsyncGenerator<RunEvent> {
  const res = await fetch(`${base(pid)}/${kind}/${encodeURIComponent(key)}/${action}`, { method: 'POST' });
  if (res.status === 409) {
    const message = await errorMessage(res, 'a run is already in progress');
    throw Object.assign(new Error(message), { alreadyRunning: true });
  }
  if (!res.ok || !res.body) throw new Error(await errorMessage(res, `run failed with ${res.status}`));
  yield* readNdjson(res.body);
}

async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<RunEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line) as RunEvent;
      nl = buffer.indexOf('\n');
    }
  }
  const rest = buffer.trim();
  if (rest) yield JSON.parse(rest) as RunEvent;
}

export interface MeetingEntry {
  id: number;
  title: string;
  participants: string[];
  ticketId: number | null;
  epicId: number | null;
  status: 'OPEN' | 'ENDED';
  summary: string | null;
  updatedAt: string;
}
export interface MeetingMessageEntry {
  id: number;
  speaker: string;
  text: string;
  createdAt: string;
}
export type MeetingDetail = MeetingEntry & { messages: MeetingMessageEntry[] };

export const fetchMeetings = (pid: string) => getJson<{ meetings: MeetingEntry[] }>(`${base(pid)}/meetings`).then((r) => r.meetings);
export const fetchMeeting = (pid: string, id: string) => getJson<MeetingDetail>(`${base(pid)}/meetings/${id}`);
export const createMeeting = (pid: string, body: { title: string; participants: string[]; ticketKey?: string; epicKey?: string }) =>
  postJson<MeetingEntry>(`${base(pid)}/meetings`, body);
export const sayInMeeting = (pid: string, id: number, text: string, to: string | null) =>
  postJson<{ reply: MeetingMessageEntry }>(`${base(pid)}/meetings/${id}/say`, { text, to });
export const concludeMeetingApi = (pid: string, id: number) =>
  postJson<{ summary: string; createdTickets: string[] }>(`${base(pid)}/meetings/${id}/conclude`);
