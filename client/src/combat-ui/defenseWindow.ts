import type { TelegraphEvent } from '../net/contract';
export function defenseWindow(a: TelegraphEvent, now: number, id: string | null) {
  const end = a.impactServerMs + a.windowMs;
  return { targeted: id !== null && a.targetPlayerIds.includes(id), sampling: now >= a.impactServerMs && now <= end, reportable: now > end && now <= end + 400 };
}
