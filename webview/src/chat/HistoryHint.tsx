import { useLayoutEffect, useState } from "react";

export function ColdHistoryHint() {
  const [show, setShow] = useState(false);
  useLayoutEffect(() => {
    const timer = setTimeout(() => setShow(true), 120);
    return () => clearTimeout(timer);
  }, []);
  return show ? (
    <HistoryHint hasMore={false} loading={false} loaded={false} count={0} reveal />
  ) : null;
}

// Top-of-list status for paginated history: what is happening while older
// messages load, and where the conversation begins.
export function HistoryHint({
  hasMore,
  loading,
  loaded,
  count,
  reveal = false,
}: {
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  count: number;
  reveal?: boolean;
}) {
  if (!loaded) {
    return (
      <div className={`history-hint history-loading${reveal ? " history-cold-reveal" : ""}`}>
        <span className="spinner" /> Loading conversation…
      </div>
    );
  }
  if (loading) {
    return (
      <div className="history-hint history-loading">
        <span className="spinner" /> Loading older messages…
      </div>
    );
  }
  if (hasMore) return <div className="history-hint">Scroll up for older messages</div>;
  if (count > 0) return <div className="history-hint history-start">Beginning of conversation</div>;
  return null;
}
