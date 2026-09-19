import { useEffect, useState } from 'react';
import { Bot, Check, Clock, Play, X } from 'lucide-react';
import { BackLink } from '@/components/back-link';
import { ArtifactContent } from '@/components/artifact';
import { RunPanel } from '@/components/run-panel';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { approveEpic, eventsUrl, fetchEpic, rejectEpic, runStream } from '@/lib/api';
import { duration, money } from '@/lib/format';
import { useChangeFeed, useResource } from '@/lib/hooks';
import { projectHref } from '@/lib/router';
import { epicStateLabel, epicTone, stateLabel, ticketTone } from '@/lib/status';
import type { EpicDetail, RunEvent } from '@/lib/types';

type Panel = { driver: AsyncGenerator<RunEvent> } | 'reattach' | null;

export function EpicView({ projectId, keyId }: { projectId: string; keyId: string }) {
  const { data, error, reload } = useResource<EpicDetail>(() => fetchEpic(projectId, keyId), [projectId, keyId]);
  const [panel, setPanel] = useState<Panel>(null);
  const [feedback, setFeedback] = useState('');
  useChangeFeed(eventsUrl(projectId), reload, panel !== null);

  useEffect(() => {
    if (data?.running && panel === null) setPanel('reattach');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.running]);

  const plan = () => setPanel({ driver: runStream(projectId, 'epics', keyId, 'plan') });
  const build = () => setPanel({ driver: runStream(projectId, 'epics', keyId, 'run') });
  const approve = async () => {
    await approveEpic(projectId, keyId);
    setPanel({ driver: runStream(projectId, 'epics', keyId, 'run') });
  };
  const reject = async () => {
    await rejectEpic(projectId, keyId, feedback.trim());
    setPanel({ driver: runStream(projectId, 'epics', keyId, 'plan') });
  };

  const cost = data?.costUsd ?? 0;

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <BackLink fallback={projectHref(projectId)} />
      {error ? <p className="text-sm text-destructive">Failed to load: {error}</p> : null}
      {!data && !error ? (
        <div className="space-y-6">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : null}
      {!data ? null : (
        <div className="space-y-8">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-sm text-muted-foreground">{data.key}</span>
              <StatusBadge tone={epicTone(data.status)} label={epicStateLabel(data.status)} running={data.running} />
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
              <div className="ml-auto flex gap-2">
                {data.status === 'PLANNING' && !data.running ? (
                  <Button size="sm" onClick={plan}>
                    <Play className="size-4" /> Plan
                  </Button>
                ) : null}
                {data.status === 'BUILDING' && !data.running ? (
                  <Button size="sm" onClick={build}>
                    <Play className="size-4" /> Run
                  </Button>
                ) : null}
              </div>
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">{data.title}</h1>
          </div>

          {data.subtickets.length > 0
            ? (() => {
                const done = data.subtickets.filter((s) => s.status === 'DONE').length;
                const blocked = data.subtickets.filter((s) => s.status === 'BLOCKED').length;
                const pct = Math.round((done / data.subtickets.length) * 100);
                return (
                  <Card>
                    <CardContent className="space-y-2.5 p-4">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium">
                          {done} of {data.subtickets.length} subtickets done
                        </span>
                        <span className="text-muted-foreground">{pct}%</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      {blocked > 0 ? (
                        <p className="text-xs text-destructive">{blocked} blocked, needs your attention</p>
                      ) : null}
                    </CardContent>
                  </Card>
                );
              })()
            : null}

          {data.status === 'AWAIT_PLAN' ? (
            <Card className="border-foreground/20">
              <CardContent className="space-y-3 p-4">
                <p className="text-sm font-medium">Review the proposed breakdown, then approve or send it back.</p>
                <Textarea
                  rows={2}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="Feedback for the planner (required to reject)"
                />
                <div className="flex gap-2">
                  <Button onClick={approve}>
                    <Check className="size-4" /> Approve &amp; build
                  </Button>
                  <Button variant="outline" disabled={!feedback.trim()} onClick={reject}>
                    <X className="size-4" /> Reject
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {panel ? (
            <RunPanel
              projectId={projectId}
              kind="epics"
              target={keyId}
              driver={panel === 'reattach' ? null : panel.driver}
              startedAt={data.runStartedAt}
              onFinished={reload}
            />
          ) : null}

          <section className="space-y-3">
            <h2 className="text-sm font-semibold tracking-tight">Goal</h2>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{data.description}</p>
          </section>

          {data.subtickets.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold tracking-tight">Subtickets</h2>
              <div className="divide-y overflow-hidden rounded-lg border">
                {data.subtickets.map((s) => {
                  const depKeys = s.dependsOn
                    .map((seq) => data.subtickets.find((d) => d.seq === seq)?.key)
                    .filter(Boolean);
                  return (
                    <a
                      key={s.key}
                      href={projectHref(projectId, `/tickets/${s.key}`)}
                      className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent/40"
                    >
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                        {s.seq}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-muted-foreground">{s.key}</span>
                          {depKeys.length > 0 ? (
                            <span className="text-[11px] text-muted-foreground">depends on {depKeys.join(', ')}</span>
                          ) : null}
                        </div>
                        <p className="truncate font-medium">{s.title || s.description}</p>
                      </div>
                      <StatusBadge tone={ticketTone(s.status)} label={stateLabel(s.status)} />
                    </a>
                  );
                })}
              </div>
            </section>
          ) : data.plan ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold tracking-tight">Proposed plan</h2>
              <ArtifactContent kind="PLAN" content={data.plan} />
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
