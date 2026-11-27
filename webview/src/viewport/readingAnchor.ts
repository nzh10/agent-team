export type ReadingPosition =
  | { following: true }
  | { following: false; id?: string; offset: number; top: number; timestamp?: number };

export function rememberReadingPosition(el: HTMLElement, following: boolean): ReadingPosition {
  if (following) return { following: true };
  const top = el.getBoundingClientRect().top;
  const items = el.querySelectorAll<HTMLElement>(
    ".message[id], .system-message[id], .message-render-error[id]",
  );
  // Rows are stacked in DOM order. Do not measure every row on scroll.
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (items[mid].getBoundingClientRect().bottom > top) high = mid;
    else low = mid + 1;
  }
  const item = items[low];
  if (item)
    return {
      following: false,
      id: item.id,
      offset: item.getBoundingClientRect().top - top,
      top: el.scrollTop,
    };
  return { following: false, offset: 0, top: el.scrollTop };
}

export function readingAnchorElement(el: HTMLElement, id?: string): HTMLElement | undefined {
  const item = id && document.getElementById(id);
  return item && el.contains(item) ? item : undefined;
}

export function restoreReadingPosition(el: HTMLElement, position: ReadingPosition): void {
  if (position.following) {
    el.scrollTop = el.scrollHeight;
    return;
  }
  const item = readingAnchorElement(el, position.id);
  el.scrollTop = item
    ? el.scrollTop +
      item.getBoundingClientRect().top -
      el.getBoundingClientRect().top -
      position.offset
    : position.top;
}
