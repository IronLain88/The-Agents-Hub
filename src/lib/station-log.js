const MAX_BREADCRUMBS = 15;

/** Format a timestamped breadcrumb line. */
export function formatBreadcrumb(detail, timestamp) {
  const ts = timestamp || new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return `${ts} - ${detail}`;
}

/**
 * Append a breadcrumb to log lines, keeping a rolling window.
 * Notes (lines after a '---' separator) are preserved and not counted.
 * Returns the new log string.
 */
export function applyBreadcrumb(log, breadcrumb) {
  const lines = log.split('\n').filter(l => l.trim() !== '');

  const noteSeparator = lines.findIndex(l => l.trim() === '---');
  const breadcrumbs = noteSeparator === -1 ? lines : lines.slice(0, noteSeparator);
  const notes = noteSeparator === -1 ? [] : lines.slice(noteSeparator);

  const trimmed = breadcrumbs.slice(-(MAX_BREADCRUMBS - 1));
  trimmed.push(breadcrumb);

  return [...trimmed, ...notes].join('\n');
}

/**
 * Append a reflection note to log lines.
 * Notes go after the '---' separator and are never trimmed.
 * Returns the new log string.
 */
export function applyNote(log, note) {
  const lines = log.split('\n').filter(l => l.trim() !== '');

  const noteSeparator = lines.findIndex(l => l.trim() === '---');
  const breadcrumbs = noteSeparator === -1 ? lines : lines.slice(0, noteSeparator);
  const existingNotes = noteSeparator === -1 ? [] : lines.slice(noteSeparator);

  if (existingNotes.length === 0) {
    existingNotes.push('---');
  }
  existingNotes.push(`Note: ${note}`);

  return [...breadcrumbs, ...existingNotes].join('\n');
}
