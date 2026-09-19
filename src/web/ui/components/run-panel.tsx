import { useEffect, useRef, useState } from 'react';
import { Loader2, Square } from 'lucide-react';
import { RelativeTime } from '@/components/relative-time';
import { Button } from '@/components/ui/button';
import { cancelRun, logUrl } from '@/lib/api';
import { parseUtc } from '@/lib/format';
import type { RunEvent } from '@/lib/types';
import { cn } from '@/lib/utils';

type Kind = 'tickets' | 'epics';
type Phase = 'running' | 'done' | 'error';

interface RunPanelProps {
  projectId: string;
  kind: Kind;
  target: string;
  // A stream to drive immediately (from a Run/Plan/Approve click), or null to
  // reattach to whatever run is already in progress via the log SSE endpoint.
  driver?: AsyncGenerator<RunEvent> | null;
  // The run's actual start time (sqlite UTC), when known from the backend.
  // Falls back to component-mount time for a freshly-launched driver, whose
  // run row may not exist yet on the initial render.
  startedAt?: string | null;
  onFinished: () => void;
}

export function RunPanel({ projectId, kind, target, driver, startedAt, onFinished }: RunPanelProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>('running');
  const [finalStatus, setFinalStatus] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [mountedAt] = useState(() => new Date());
  const startedAtDate = startedAt ? parseUtc(startedAt) : mountedAt;
  const logRef = useRef<HTMLDivElement>(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  useEffect(() => {
    let active = true;
    const append = (line: string) => active && setLines((prev) => [...prev, line]);
    const settle = (next: Phase, status?: string) => {
      if (!active) return;
      setPhase(next);
      if (status) setFinalStatus(status);
      finishedRef.current();
    };

    async function consumeDriver(gen: AsyncGenerator<RunEvent>) {
      try {
        for await (const ev of gen) {
          if (ev.type === 'log') append(ev.line);
          else if (ev.type === 'done') settle('done', ev.status);
          else if (ev.type === 'error') settle('error', ev.message);
        }
      } catch (err) {
        settle('error', err instanceof Error ? err.message : String(err));
      }
    }

    function reattach() {
      const source = new EventSource(logUrl(projectId, kind, target));
      source.onmessage = (event) => {
        let ev: RunEvent;
        try {
          ev = JSON.parse(event.data);
        } catch {
          return;
        }
        if (ev.type === 'log') append(ev.line);
        else if (ev.type === 'done') {
          settle('done', ev.status);
          source.close();
        } else if (ev.type === 'error') {
          settle('error', ev.message);
          source.close();
        } else if (ev.type === 'idle') {
          settle('done');
          source.close();
        }
      };
      source.onerror = () => source.close();
      return () => source.close();
    }

    if (driver) {
      void consumeDriver(driver);
      return () => {
        active = false;
      };
    }
    const close = reattach();
    return () => {
      active = false;
      close();
    };
  }, [projectId, kind, target, driver]);

  const stop = async () => {
    setStopping(true);
    try {
      await cancelRun(projectId, kind, target);
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border bg-muted/30">
      <div className="flex items-center justify-between border-b bg-muted/50 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {phase === 'running' ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> Running
            </>
          ) : phase === 'error' ? (
            <span className="text-destructive">{finalStatus ?? 'Failed'}</span>
          ) : (
            <span className="text-muted-foreground">Finished{finalStatus ? `: ${finalStatus}` : ''}</span>
          )}
          <RelativeTime date={startedAtDate} className="text-xs font-normal text-muted-foreground" />
        </div>
        {phase === 'running' ? (
          <Button variant="destructive" size="sm" onClick={stop} disabled={stopping}>
            <Square className="size-3" />
            {stopping ? 'Stopping' : 'Stop'}
          </Button>
        ) : null}
      </div>
      <div
        ref={logRef}
        className={cn('max-h-72 overflow-auto p-3 font-mono text-xs leading-relaxed', lines.length === 0 && 'text-muted-foreground')}
      >
        {lines.length === 0 ? 'Waiting for output…' : lines.map((line, i) => <div key={i}>{line}</div>)}
      </div>
    </div>
  );
}
