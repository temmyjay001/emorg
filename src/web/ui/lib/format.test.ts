import { describe, expect, it } from 'vitest';
import { relativeTime } from './format';

describe('relativeTime', () => {
  it('renders a few-minutes-old date in minutes', () => {
    const now = new Date('2024-01-01T00:04:30Z');
    const date = new Date('2024-01-01T00:00:00Z');
    expect(relativeTime(date, now)).toBe('4m ago');
  });

  it('renders a several-hours-old date in hours', () => {
    const now = new Date('2024-01-01T03:00:00Z');
    const date = new Date('2024-01-01T00:00:00Z');
    expect(relativeTime(date, now)).toBe('3h ago');
  });

  it('renders a multi-day-old date in days', () => {
    const now = new Date('2024-01-04T00:00:00Z');
    const date = new Date('2024-01-01T00:00:00Z');
    expect(relativeTime(date, now)).toBe('3d ago');
  });

  it('renders a just-elapsed date as just now', () => {
    const now = new Date('2024-01-01T00:00:30Z');
    const date = new Date('2024-01-01T00:00:00Z');
    expect(relativeTime(date, now)).toBe('just now');
  });
});
