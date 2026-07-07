"use client";
/**
 * The island (§16 step 2): an interactive client component referenced from
 * inside a server-rendered rsc field. Ships to the browser as its own chunk
 * via the plugin manifest — unlike the markdown renderer around it.
 */
import { useState } from "react";

export function LikeButton({ initial }: { initial: number }) {
  const [likes, setLikes] = useState(initial);
  return (
    <button type="button" data-testid="doc-counter" onClick={() => setLikes(likes + 1)}>
      likes: {likes}
    </button>
  );
}
