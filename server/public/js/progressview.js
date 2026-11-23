// What the progress bar shows, worked out apart from the page so that it can be tested (and so that the
// Windows game can be built to say the same): how full the bar is, the words of the little note that pops
// up when points arrive, and the words of a new level. The messages are in docs/PROTOCOL.md, "Progress".

/** How full the bar is for a level, from 0 to 1. */
export function fillOf(level) {
  const span = Math.max(1, (level?.next ?? 1) - (level?.from ?? 0));
  return Math.max(0, Math.min(1, ((level?.points ?? 0) - (level?.from ?? 0)) / span));
}

/** The note for points just earned: "+3" and what earned them. Null when nothing was earned. */
export function noteOf(news) {
  if (!news || !(news.gained > 0)) return null;
  return { points: `+${news.gained}`, text: typeof news.why === "string" && news.why ? news.why : "well done" };
}

/** The words of a new level: its headline, and what it brought (coins, riddles). */
export function levelUpOf(up) {
  if (!up || !(up.n > 0)) return null;
  const brought = [];
  if (up.coins > 0) brought.push(`${up.coins} coins`);
  if (up.riddles > 0) brought.push(up.riddles === 1 ? "a new riddle" : `${up.riddles} new riddles`);
  return { title: `Level ${up.n}!`, name: up.title ?? "", text: brought.join(" and ") };
}

/** What hovering over the bar says: the sums, for those who want them. */
export function tipOf(level) {
  if (!level) return "";
  return `Level ${level.n}, ${level.title}: ${level.points} points, ${Math.max(0, level.next - level.points)} more to level ${level.n + 1}. Click to open your passport (P).`;
}
