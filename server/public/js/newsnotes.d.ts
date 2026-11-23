// Types for newsnotes.js, so the server's tests can check what the "What's new" card says.
export const ELSEWHERE: Record<"windows" | "browser", string>;
export interface CardEntry { version: string; title: string; note: string; items: { text: string; note: string }[] }
export function newsCard(news: unknown, game?: "browser" | "windows", first?: boolean): CardEntry[];
