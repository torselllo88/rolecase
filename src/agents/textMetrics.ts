/** Shared by Writer (prompt guidance), Critic (length check), and orchestrator (post-hoc warning). */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}
