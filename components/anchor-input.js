"use client";
import { useEffect, useRef, useState } from "react";
export default function AnchorInput({ day, value, onCommit }) {
  const [draft, setDraft] = useState(String(Number((value * 100).toFixed(1)))),
    [focused, setFocused] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!focused) setDraft(String(Number((value * 100).toFixed(1))));
  }, [value, focused]);
  function finish() {
    const n = Number(draft);
    if (
      !cancelled.current &&
      draft.trim() !== "" &&
      Number.isFinite(n) &&
      n >= 0 &&
      n <= 100
    )
      onCommit(n / 100);
    cancelled.current = false;
    setFocused(false);
    setDraft(String(Number((value * 100).toFixed(1))));
  }
  return (
    <input
      aria-label={`D${day} 留存（%）`}
      type="number"
      min="0"
      max="100"
      step=".1"
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}
