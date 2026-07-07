"use client";
/** The island: interactive client component referenced from server markup. */
import { useState } from "react";

export function Counter({ start }: { start: number }) {
  const [n, setN] = useState(start);
  return (
    <button type="button" data-testid="counter" onClick={() => setN(n + 1)}>
      count: {n}
    </button>
  );
}
