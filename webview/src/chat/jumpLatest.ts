export interface ViewportRect {
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export function isMessageRectVisible(
  scrollerRect: ViewportRect,
  messageRect: ViewportRect,
): boolean {
  if (scrollerRect.height <= 0 || (messageRect.height <= 0 && messageRect.width <= 0)) {
    return false;
  }
  return messageRect.top < scrollerRect.bottom && messageRect.bottom > scrollerRect.top;
}

export function findLatestMessageElement(
  scroller: HTMLElement,
  latestMessageId?: string | null,
): HTMLElement | null {
  if (latestMessageId) {
    const byId = document.getElementById(`msg-${latestMessageId}`);
    if (byId && scroller.contains(byId)) return byId;
  }
  const content = scroller.firstElementChild;
  if (!content || content.hasAttribute("data-loaded-messages")) return null;
  for (let child = content.lastElementChild; child; child = child.previousElementSibling) {
    if (
      child instanceof HTMLElement &&
      (child.classList.contains("message") ||
        child.classList.contains("system-message") ||
        child.classList.contains("message-render-error"))
    ) {
      return child;
    }
  }
  return null;
}

export function isLatestMessageVisible(
  scroller: HTMLElement | null,
  latestMessageId?: string | null,
): boolean {
  if (!scroller) return false;
  const latestEl = findLatestMessageElement(scroller, latestMessageId);
  if (!latestEl) return false;
  return isMessageRectVisible(scroller.getBoundingClientRect(), latestEl.getBoundingClientRect());
}

export function shouldShowJumpToLatest({
  following,
  messagesLoaded,
  messageCount,
  latestVisible,
}: {
  following: boolean;
  messagesLoaded?: boolean;
  messageCount: number;
  latestVisible: boolean;
}): boolean {
  return !following && !!messagesLoaded && messageCount > 0 && !latestVisible;
}
