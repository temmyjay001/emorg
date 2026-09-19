import { useEffect, useState } from 'react';
import { absoluteTime, relativeTime } from '@/lib/format';

const TICK_MS = 30_000;

export function RelativeTime({ date, className }: { date: Date; className?: string }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <span className={className} title={absoluteTime(date)}>
      {relativeTime(date, now)}
    </span>
  );
}
