const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_BASE = process.env.NTFY_URL ?? 'https://ntfy.sh';

export type NotifyPriority = 'min' | 'low' | 'default' | 'high' | 'urgent';

interface NotifyOptions {
  title: string;
  message: string;
  priority?: NotifyPriority;
  tags?: string[];
  url?: string;
}

export async function sendNotification(opts: NotifyOptions): Promise<boolean> {
  if (!NTFY_TOPIC) return false;

  try {
    const headers: Record<string, string> = {
      'Title': opts.title,
      'Priority': opts.priority ?? 'default',
    };
    if (opts.tags?.length) headers['Tags'] = opts.tags.join(',');
    if (opts.url) headers['Click'] = opts.url;

    const res = await fetch(`${NTFY_BASE}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers,
      body: opts.message,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function notifyDailyPick(spotCount: number, picks: number[], bestHour: number | null) {
  const hourLabel = bestHour !== null
    ? `Best window: ${bestHour > 12 ? bestHour - 12 : bestHour}:00 ${bestHour >= 12 ? 'PM' : 'AM'} ET`
    : '';
  await sendNotification({
    title: `Today's Pick: ${spotCount}-Spot`,
    message: `Numbers: ${picks.sort((a, b) => a - b).join(', ')}${hourLabel ? `\n${hourLabel}` : ''}`,
    priority: 'high',
    tags: ['game_die', 'keknow'],
    url: 'https://ke-know.vercel.app/daily-pick',
  });
}

export async function notifyPlayWindow(spotCount: number, hour: number) {
  const h = hour > 12 ? hour - 12 : hour;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  await sendNotification({
    title: 'Play Window Open',
    message: `Your best play window is NOW (${h}:00 ${suffix} ET). ${spotCount}-spot pick is ready.`,
    priority: 'urgent',
    tags: ['rotating_light', 'keknow'],
    url: 'https://ke-know.vercel.app/daily-pick',
  });
}

export async function notifyBigWin(prize: number, spotCount: number, matches: number) {
  await sendNotification({
    title: `Big Win: $${prize}`,
    message: `${matches}/${spotCount} matches on a ${spotCount}-spot play!`,
    priority: 'high',
    tags: ['trophy', 'keknow'],
    url: 'https://ke-know.vercel.app/monitor',
  });
}

export async function notifyEvolution(generation: number, promotions: number) {
  if (promotions === 0) return;
  await sendNotification({
    title: `Gen ${generation} Complete`,
    message: `${promotions} new champion${promotions !== 1 ? 's' : ''} promoted. Arthur is learning.`,
    priority: 'default',
    tags: ['dna', 'keknow'],
    url: 'https://ke-know.vercel.app/admin/strategy-lab',
  });
}

export async function notifySystemAlert(message: string) {
  await sendNotification({
    title: 'System Alert',
    message,
    priority: 'high',
    tags: ['warning', 'keknow'],
    url: 'https://ke-know.vercel.app/monitor',
  });
}
