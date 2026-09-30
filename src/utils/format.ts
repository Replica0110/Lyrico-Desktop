export function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function shortPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.length <= 2) {
    return path;
  }
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

export function formatDateTime(value?: string, locale?: string) {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString(locale);
}

export function formatTimestamp(seconds?: number) {
  if (!seconds) {
    return "-";
  }
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseTimeValue(value?: string): number {
  if (!value) {
    return 0;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

export function formatTimeValue(value?: string, locale?: string) {
  const seconds = parseTimeValue(value);
  if (!seconds) {
    return "-";
  }
  if (/^\d+$/.test(value ?? "")) {
    return formatTimestamp(seconds);
  }
  return new Date(seconds * 1000).toLocaleString(locale);
}
