import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, Clock, Play, Plus, Rocket, Send, X } from 'lucide-react';
import { BackLink } from '@/components/back-link';
import { ArtifactContent, evidenceMeta } from '@/components/artifact';
import { RelativeTime } from '@/components/relative-time';
import { RunPanel } from '@/components/run-panel';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  acceptDraft,
  addTicketRelation,
  approveTicket,
  type DraftMessageEntry,
  eventsUrl,
  fetchBoard,
  fetchDraft,
  fetchLabels,
  fetchTicket,
  rejectTicket,
  removeTicketRelation,
  runStream,
  sayInDraft,
  setTicketLabels,
  setTicketPriority,
  unblockTicket,
} from '@/lib/api';
import { duration, money, parseUtc } from '@/lib/format';
import { useChangeFeed, useResource } from '@/lib/hooks';
import { projectHref } from '@/lib/router';
import { PRIORITY_LEVELS, stateLabel, ticketTone } from '@/lib/status';
import type { AgentRun, Artifact, RunEvent, TicketDetail, TicketRelation, TicketRelationType, TicketState } from '@/lib/types';

const ACTIONABLE = new Set(['BACKLOG', 'DESIGN', 'READY', 'IN_PROGRESS', 'IN_REVIEW', 'UAT']);
const RELATION_TYPE_OPTIONS: { value: TicketRelationType; label: string }[] = [
  { value: 'blocks', label: 'Blocks' },
  { value: 'relates-to', label: 'Relates to' },
];

interface TicketOption {
  id: number;
  key: string;
  title: string;
}

type Panel = { driver: AsyncGenerator<RunEvent> } | 'reattach' | null;

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function PriorityEditor({ priority, onChange }: { priority: string; onChange: (priority: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = async (value: string) => {
    if (value === priority) return;
    setBusy(true);
    setError(null);
    try {
      await onChange(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <select
        aria-label="Priority"
        className="h-7 rounded-md border border-input bg-transparent px-2 text-xs font-medium capitalize shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
        value={priority}
        disabled={busy}
        onChange={(e) => void handleChange(e.target.value)}
      >
        {PRIORITY_LEVELS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

function LabelEditor({
  labels,
  suggestions,
  onAdd,
  onRemove,
}: {
  labels: string[];
  suggestions: string[];
  onAdd: (label: string) => Promise<void>;
  onRemove: (label: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = useMemo(() => suggestions.filter((s) => !labels.includes(s)), [suggestions, labels]);
  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    return q ? available.filter((s) => s.includes(q)) : available;
  }, [available, text]);

  const submit = async (raw: string) => {
    const label = raw.trim().toLowerCase();
    if (!label) {
      setError('Label cannot be blank');
      return;
    }
    if (labels.includes(label)) {
      setError(`"${label}" is already applied to this ticket`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAdd(label);
      setText('');
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (label: string) => {
    setError(null);
    try {
      await onRemove(label);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {labels.length === 0 ? <p className="text-sm text-muted-foreground">No labels yet.</p> : null}
        {labels.map((label) => (
          <Badge key={label} variant="secondary" className="gap-1">
            {label}
            <button
              type="button"
              aria-label={`Remove label ${label}`}
              onClick={() => void remove(label)}
              className="ml-0.5 rounded-full hover:opacity-70"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="relative max-w-xs">
        <Input
          value={text}
          placeholder="Add a label"
          disabled={busy}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit(text);
            }
          }}
        />
        {open && filtered.length > 0 ? (
          <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover shadow-md">
            {filtered.map((label) => (
              <button
                key={label}
                type="button"
                className="block w-full px-2.5 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => void submit(label)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function RelationEditor({
  ticketKey,
  relations,
  ticketsById,
  candidates,
  onAdd,
  onRemove,
}: {
  ticketKey: string;
  relations: TicketRelation[];
  ticketsById: Map<number, TicketOption>;
  candidates: TicketOption[];
  onAdd: (type: TicketRelationType, targetKey: string) => Promise<void>;
  onRemove: (relationId: number) => Promise<void>;
}) {
  const [type, setType] = useState<TicketRelationType>('blocks');
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<TicketOption | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const pool = candidates.filter((c) => c.key !== ticketKey);
    const q = query.trim().toLowerCase();
    if (!q) return pool;
    return pool.filter((c) => c.key.toLowerCase().includes(q) || c.title.toLowerCase().includes(q));
  }, [candidates, query, ticketKey]);

  const submit = async () => {
    if (!target) {
      setError('Choose a target ticket');
      return;
    }
    const duplicate = relations.some(
      (r) => r.relationType === type && ticketsById.get(r.otherTicketId)?.key === target.key,
    );
    if (duplicate) {
      setError(`Already ${type === 'blocks' ? 'blocks' : 'related to'} ${target.key}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAdd(type, target.key);
      setQuery('');
      setTarget(null);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (relationId: number) => {
    setError(null);
    try {
      await onRemove(relationId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-3">
      {relations.length === 0 ? (
        <p className="text-sm text-muted-foreground">No relations yet.</p>
      ) : (
        <div className="divide-y rounded-lg border">
          {relations.map((r) => {
            const other = ticketsById.get(r.otherTicketId);
            return (
              <div key={r.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <Badge variant="outline" className="shrink-0 capitalize">
                  {r.relationType}
                </Badge>
                <span className="font-mono text-xs text-muted-foreground">{other?.key ?? '?'}</span>
                <span className="flex-1 truncate">{other?.title ?? 'Unknown ticket'}</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove relation to ${other?.key ?? ''}`}
                  onClick={() => void remove(r.id)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Relation type"
          className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm"
          value={type}
          disabled={busy}
          onChange={(e) => setType(e.target.value as TicketRelationType)}
        >
          {RELATION_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <div className="relative max-w-xs flex-1">
          <Input
            role="combobox"
            aria-label="Target ticket"
            value={target ? `${target.key} — ${target.title}` : query}
            placeholder="Search tickets by key or title"
            disabled={busy}
            onChange={(e) => {
              setTarget(null);
              setQuery(e.target.value);
              setError(null);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
          />
          {open && filtered.length > 0 ? (
            <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
              {filtered.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="block w-full px-2.5 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    setTarget(c);
                    setQuery('');
                    setOpen(false);
                  }}
                >
                  <span className="font-mono text-xs text-muted-foreground">{c.key}</span> {c.title}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <Button type="button" size="sm" disabled={busy || !target} onClick={() => void submit()}>
          <Plus className="size-4" /> Add relation
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function AgentRuns({ runs }: { runs: AgentRun[] }) {
  if (runs.length === 0) return <p className="text-sm text-muted-foreground">No agent runs yet.</p>;
  return (
    <div className="divide-y rounded-lg border">
      {runs.map((run) => (
        <div key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
          <span className="w-20 font-medium capitalize">{run.role}</span>
          <span className="text-muted-foreground">{[run.runner ?? 'claude-sdk', run.model].filter(Boolean).join(' · ')}</span>
          <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            {run.status === 'ERROR' ? <span className="text-destructive">ERROR</span> : null}
            {run.costUsd > 0 ? <span>{money(run.costUsd)}</span> : null}
            {run.inputTokens != null ? (
              <span>
                {run.inputTokens.toLocaleString()}↓ {(run.outputTokens ?? 0).toLocaleString()}↑{' '}
                {(run.cacheReadTokens ?? 0).toLocaleString()} cache-read, {(run.cacheWriteTokens ?? 0).toLocaleString()} cache-write
              </span>
            ) : null}
            {run.durationMs > 0 ? <span>{Math.round(run.durationMs / 1000)}s</span> : null}
          </span>
          {run.status === 'ERROR' && run.error ? <p className="w-full text-xs text-destructive">{run.error}</p> : null}
        </div>
      ))}
    </div>
  );
}

function Artifacts({ artifacts }: { artifacts: Artifact[] }) {
  const [selected, setSelected] = useState(artifacts.length - 1);
  if (artifacts.length === 0) return <p className="text-sm text-muted-foreground">No artifacts yet.</p>;
  const current = artifacts[Math.min(selected, artifacts.length - 1)];
  return (
    <div className="grid gap-3 md:grid-cols-[180px_1fr]">
      <div className="flex flex-col gap-1">
        {artifacts.map((a, i) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setSelected(i)}
            className={`rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
              i === Math.min(selected, artifacts.length - 1)
                ? 'bg-secondary font-medium'
                : 'text-muted-foreground hover:bg-accent'
            }`}
          >
            {a.kind === 'EVIDENCE' || a.kind === 'ATTACHMENT' ? (
              <>
                <span className="block truncate">{evidenceMeta(a.data)?.name ?? 'EVIDENCE'}</span>
                <span className="opacity-60">{a.kind.toLowerCase()} · {a.role}</span>
              </>
            ) : (
              <>
                {a.kind} <span className="opacity-60">v{a.version} · {a.role}</span>
              </>
            )}
          </button>
        ))}
      </div>
      {current ? <ArtifactContent kind={current.kind} content={current.content} data={current.data} /> : null}
    </div>
  );
}

function BlockedCard({ note, role, onUnblock }: { note: string | null; role: string | null; onUnblock: (guidance: string) => Promise<void> }) {
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Card className="border-foreground/20">
      <CardContent className="space-y-3 p-4">
        <p className="text-sm font-medium">This ticket is blocked.</p>
        {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
        <Textarea
          rows={2}
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          placeholder={`Guidance for ${role ?? "the team"} (required to unblock)`}
        />
        <Button
          disabled={busy || !guidance.trim()}
          onClick={() => {
            setBusy(true);
            void onUnblock(guidance.trim());
          }}
        >
          <Play className="size-4" /> Unblock &amp; resume
        </Button>
      </CardContent>
    </Card>
  );
}

function InterruptedCard({ status, onResume }: { status: TicketState; onResume: () => void }) {
  return (
    <Card className="border-foreground/20">
      <CardContent className="space-y-3 p-4">
        <p className="text-sm font-medium">Interrupted at {stateLabel(status)}.</p>
        <p className="text-sm text-muted-foreground">
          The process driving this ticket stopped unexpectedly. Resume to continue from where it left off.
        </p>
        <Button onClick={onResume}>
          <Play className="size-4" /> Resume
        </Button>
      </CardContent>
    </Card>
  );
}

function LandCard({ note, disabled, onLand }: { note: string | null; disabled: boolean; onLand: () => void }) {
  return (
    <Card className="border-foreground/20">
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        <Button disabled={disabled} onClick={onLand}>
          <Rocket className="size-4" /> Land
        </Button>
        {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      </CardContent>
    </Card>
  );
}

function Decision({ ticket, onApprove, onReject }: { ticket: TicketDetail; onApprove: () => void; onReject: (fb: string) => void }) {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Card className="border-foreground/20">
      <CardContent className="space-y-3 p-4">
        <p className="text-sm font-medium">This ticket is waiting on your decision.</p>
        <Textarea
          rows={2}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Feedback for the PM (required to reject)"
        />
        <div className="flex gap-2">
          <Button
            onClick={() => {
              setBusy(true);
              onApprove();
            }}
            disabled={busy}
          >
            <Check className="size-4" /> Approve &amp; build
          </Button>
          <Button
            variant="outline"
            disabled={busy || !feedback.trim()}
            onClick={() => {
              setBusy(true);
              onReject(feedback.trim());
            }}
          >
            <X className="size-4" /> Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DraftConversation({ messages, onSend }: { messages: DraftMessageEntry[]; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const submit = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText('');
  };
  return (
    <Card className="flex h-full flex-col">
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">PM conversation</p>
        <div className="flex-1 space-y-2 overflow-y-auto">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No questions from the PM yet.</p>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`flex ${m.sender === 'stakeholder' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-lg border px-3 py-2 text-sm ${
                    m.sender === 'stakeholder' ? 'bg-secondary' : 'bg-muted/30'
                  }`}
                >
                  {m.sender !== 'stakeholder' ? (
                    <p className="mb-0.5 text-[11px] font-medium capitalize text-muted-foreground">{m.sender}</p>
                  ) : null}
                  <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="flex items-end gap-2">
          <Textarea
            rows={2}
            value={text}
            placeholder="Reply to the PM"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <Button size="icon" onClick={submit} disabled={!text.trim()} aria-label="Send reply">
            <Send className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DraftWorkspace({
  projectId,
  keyId,
  ticket,
  onAccepted,
}: {
  projectId: string;
  keyId: string;
  ticket: TicketDetail;
  onAccepted: () => void;
}) {
  const nextKey = useRef(0);
  const [title, setTitle] = useState(ticket.title);
  const [criteria, setCriteria] = useState(() =>
    ticket.criteria.map((c) => ({ key: nextKey.current++, text: c.text, isUi: c.isUi })),
  );
  const { data: draft } = useResource(() => fetchDraft(projectId, keyId), [projectId, keyId]);
  const [messages, setMessages] = useState<DraftMessageEntry[]>([]);
  const [accepting, setAccepting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (draft) setMessages(draft.messages);
  }, [draft]);

  const addCriterion = () => setCriteria((prev) => [...prev, { key: nextKey.current++, text: '', isUi: false }]);
  const removeCriterion = (key: number) => setCriteria((prev) => prev.filter((c) => c.key !== key));
  const updateCriterion = (key: number, text: string) =>
    setCriteria((prev) => prev.map((c) => (c.key === key ? { ...c, text } : c)));

  const sendReply = async (text: string) => {
    const optimistic: DraftMessageEntry = { id: Date.now(), ticketId: ticket.id, sender: 'stakeholder', text, createdAt: new Date().toISOString() };
    setMessages((prev) => [...prev, optimistic]);
    const { reply } = await sayInDraft(projectId, keyId, text);
    setMessages((prev) => [...prev, reply]);
  };

  const accept = async () => {
    setAccepting(true);
    setFailure(null);
    try {
      await acceptDraft(projectId, keyId, {
        title: title.trim(),
        description: ticket.description,
        criteria: criteria.filter((c) => c.text.trim()).map((c) => ({ text: c.text.trim(), isUi: c.isUi })),
        hasUi: ticket.hasUi,
        runCommand: ticket.runCommand,
        appUrl: ticket.appUrl,
      });
      onAccepted();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setAccepting(false);
    }
  };

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <Section title="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ticket title" />
        </Section>

        <Section
          title="Acceptance criteria"
          action={
            <Button type="button" size="sm" variant="outline" onClick={addCriterion}>
              <Plus className="size-4" /> Add criterion
            </Button>
          }
        >
          <div className="space-y-2">
            {criteria.length === 0 ? <p className="text-sm text-muted-foreground">No criteria yet.</p> : null}
            {criteria.map((c) => (
              <div key={c.key} className="flex items-start gap-2">
                <Textarea
                  rows={1}
                  value={c.text}
                  onChange={(e) => updateCriterion(c.key, e.target.value)}
                  placeholder="Acceptance criterion"
                  className="flex-1"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => removeCriterion(c.key)}
                  aria-label="Remove criterion"
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </Section>

        {failure ? <p className="text-sm text-destructive">{failure}</p> : null}

        <Button onClick={accept} disabled={accepting}>
          <Check className="size-4" /> Accept
        </Button>
      </div>

      <DraftConversation messages={messages} onSend={(text) => void sendReply(text)} />
    </div>
  );
}

export function TicketView({ projectId, keyId }: { projectId: string; keyId: string }) {
  const { data, error, reload } = useResource<TicketDetail>(() => fetchTicket(projectId, keyId), [projectId, keyId]);
  const { data: board } = useResource(() => fetchBoard(projectId), [projectId]);
  const { data: labelSuggestions, reload: reloadLabels } = useResource(() => fetchLabels(projectId), [projectId]);
  const [panel, setPanel] = useState<Panel>(null);
  const [landBusy, setLandBusy] = useState(false);
  const panelActive = panel !== null;
  useChangeFeed(eventsUrl(projectId), reload, panelActive);

  useEffect(() => {
    if (data?.running && panel === null) setPanel('reattach');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.running]);

  const finishPanel = () => {
    setLandBusy(false);
    reload();
  };

  const startRun = () => setPanel({ driver: runStream(projectId, 'tickets', keyId, 'run') });
  const startLand = () => {
    setLandBusy(true);
    setPanel({ driver: runStream(projectId, 'tickets', keyId, 'land') });
  };
  const approve = async () => {
    await approveTicket(projectId, keyId);
    setPanel({ driver: runStream(projectId, 'tickets', keyId, 'run') });
  };
  const reject = async (fb: string) => {
    await rejectTicket(projectId, keyId, fb);
    setPanel({ driver: runStream(projectId, 'tickets', keyId, 'run') });
  };

  const changePriority = async (priority: string) => {
    await setTicketPriority(projectId, keyId, priority);
    reload();
  };
  const addLabel = async (label: string) => {
    await setTicketLabels(projectId, keyId, [...(data?.labels ?? []), label]);
    reload();
    reloadLabels();
  };
  const removeLabel = async (label: string) => {
    await setTicketLabels(projectId, keyId, (data?.labels ?? []).filter((l) => l !== label));
    reload();
  };
  const addRelation = async (type: TicketRelationType, targetKey: string) => {
    await addTicketRelation(projectId, keyId, type, targetKey);
    reload();
  };
  const removeRelation = async (relationId: number) => {
    await removeTicketRelation(projectId, keyId, relationId);
    reload();
  };

  const ticketOptions: TicketOption[] = useMemo(() => {
    if (!board) return [];
    const options: TicketOption[] = [];
    for (const epic of board.epics) for (const t of epic.subtickets) options.push({ id: t.id, key: t.key, title: t.title });
    for (const t of board.standaloneTickets) options.push({ id: t.id, key: t.key, title: t.title });
    return options;
  }, [board]);
  const ticketsById = useMemo(() => new Map(ticketOptions.map((t) => [t.id, t])), [ticketOptions]);

  const cost = data?.costUsd ?? 0;
  const canRun = data && ACTIONABLE.has(data.status) && !data.running && data.status !== 'AWAIT_APPROVAL' && !data.interrupted;
  const criteria = data?.criteria ?? [];
  const met = useMemo(() => criteria.filter((c) => c.met).length, [criteria]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <BackLink fallback={projectHref(projectId)} />

      {error ? <p className="text-sm text-destructive">Failed to load: {error}</p> : null}
      {!data && !error ? (
        <div className="space-y-6">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : null}
      {!data ? null : (
        <div className="space-y-8">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-sm text-muted-foreground">{data.key}</span>
              <StatusBadge tone={ticketTone(data.status)} label={stateLabel(data.status)} running={data.running} />
              {data.interrupted ? (
                <StatusBadge tone="attention" label={`Interrupted at ${stateLabel(data.status)}`} />
              ) : null}
              <PriorityEditor priority={data.priority} onChange={changePriority} />
              {cost > 0 ? <Badge variant="muted">{money(cost)}</Badge> : null}
              {data.leadTimeMs !== null ? (
                <Badge variant="muted">
                  <Clock className="size-3" /> {duration(data.leadTimeMs)}
                </Badge>
              ) : null}
              {data.agentTimeMs > 0 ? (
                <Badge variant="muted">
                  <Bot className="size-3" /> {duration(data.agentTimeMs)}
                </Badge>
              ) : null}
              {data.gate ? <span className="text-xs text-muted-foreground">gate: {data.gate}</span> : null}
              {data.attempt > 0 ? <span className="text-xs text-muted-foreground">attempt {data.attempt}</span> : null}
              {canRun ? (
                <Button size="sm" className="ml-auto" onClick={startRun}>
                  <Play className="size-4" /> Run
                </Button>
              ) : null}
            </div>
            {data.status !== 'DRAFT' ? (
              <h1 className="mt-2 text-2xl font-semibold tracking-tight">{data.title || '(untitled)'}</h1>
            ) : null}
          </div>

          <Section title="Labels">
            <LabelEditor
              labels={data.labels}
              suggestions={labelSuggestions ?? []}
              onAdd={addLabel}
              onRemove={removeLabel}
            />
          </Section>

          <Section title="Relations">
            <RelationEditor
              ticketKey={data.key}
              relations={data.relations}
              ticketsById={ticketsById}
              candidates={ticketOptions}
              onAdd={addRelation}
              onRemove={removeRelation}
            />
          </Section>

          {data.status === 'DRAFT' ? (
            <DraftWorkspace projectId={projectId} keyId={keyId} ticket={data} onAccepted={reload} />
          ) : (
            <>
              {data.status === 'AWAIT_APPROVAL' ? (
                <Decision ticket={data} onApprove={approve} onReject={reject} />
              ) : null}

              {data.interrupted && !data.running && data.status !== 'BLOCKED' ? (
                <InterruptedCard status={data.status} onResume={startRun} />
              ) : null}

              {data.status === 'BLOCKED' ? (
                <BlockedCard
                  note={data.transitions.at(-1)?.note ?? null}
                  role={data.unblockRole}
                  onUnblock={async (guidance) => {
                    await unblockTicket(projectId, keyId, guidance);
                    setPanel({ driver: runStream(projectId, 'tickets', keyId, 'run') });
                  }}
                />
              ) : null}

              {data.status === 'READY_TO_LAND' || data.status === 'NEEDS_INTEGRATION' ? (
                <LandCard
                  note={data.status === 'NEEDS_INTEGRATION' ? (data.transitions.at(-1)?.note ?? null) : null}
                  disabled={landBusy || data.running}
                  onLand={startLand}
                />
              ) : null}

              {panel ? (
                <RunPanel
                  projectId={projectId}
                  kind="tickets"
                  target={keyId}
                  driver={panel === 'reattach' ? null : panel.driver}
                  startedAt={data.runStartedAt}
                  onFinished={finishPanel}
                />
              ) : null}

              <Section title="Request">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{data.description}</p>
              </Section>

              {criteria.length > 0 ? (
                <Section title="Acceptance criteria" action={<span className="text-xs text-muted-foreground">{met}/{criteria.length} met</span>}>
                  <div className="space-y-1.5">
                    {criteria.map((c) => (
                      <div key={c.id} className="flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm">
                        <span className={`mt-0.5 ${c.met ? 'text-foreground' : 'text-muted-foreground/50'}`}>
                          {c.met ? <Check className="size-4" /> : <div className="size-4 rounded-sm border" />}
                        </span>
                        <span className="flex-1">{c.text}</span>
                        {c.isUi ? <Badge variant="outline" className="shrink-0">UI</Badge> : null}
                      </div>
                    ))}
                  </div>
                </Section>
              ) : null}

              {data.agentRuns.length > 0 ? (
                <Section title="Agent runs">
                  <AgentRuns runs={data.agentRuns} />
                </Section>
              ) : null}

              {data.transitions.length > 0 ? (
                <Section title="History">
                  <div className="divide-y overflow-hidden rounded-lg border">
                    {data.transitions.map((t) => (
                      <div key={t.id} className="px-4 py-2.5">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-muted-foreground">{stateLabel(t.fromState)}</span>
                          <span className="text-muted-foreground/50">→</span>
                          <span className="font-medium">{stateLabel(t.toState)}</span>
                          <span className="text-xs capitalize text-muted-foreground">· {t.role ?? 'you'}</span>
                          {t.verdict ? (
                            <span
                              className={`text-[11px] font-medium ${t.verdict === 'FAIL' ? 'text-destructive' : 'text-muted-foreground'}`}
                            >
                              {t.verdict}
                            </span>
                          ) : null}
                          <RelativeTime
                            date={parseUtc(t.createdAt)}
                            className="ml-auto shrink-0 text-xs text-muted-foreground"
                          />
                        </div>
                        {t.note ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t.note}</p> : null}
                      </div>
                    ))}
                  </div>
                </Section>
              ) : null}

              {data.artifacts.length > 0 ? (
                <>
                  <Separator />
                  <Section title="Artifacts">
                    <Artifacts artifacts={data.artifacts} />
                  </Section>
                </>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
