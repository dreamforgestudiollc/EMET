const ZONE_KEY = 'emet-console-zone';

export function timeZone(): string {
  try {
    const saved = localStorage.getItem(ZONE_KEY);
    if (saved && saved.trim()) return saved.trim();
  } catch { /* private mode keeps the default */ }
  return 'America/New_York';
}

export function setTimeZone(zone: string): void {
  localStorage.setItem(ZONE_KEY, zone);
}

export function zoneLabel(zone: string): string {
  return zone === 'America/New_York' ? 'ET' : zone;
}

export function formatWhen(value: string | number | Date, zone = timeZone()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
  return `${text} ${zoneLabel(zone)}`;
}
