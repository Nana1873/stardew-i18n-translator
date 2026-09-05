/** Reserve 100% for exact coverage, even when only one string is missing. */
export function coveragePercent(covered: number, total: number): number {
  if (total <= 0 || covered <= 0) return 0;
  if (covered >= total) return 100;
  const percent = (covered / total) * 100;
  return percent >= 99.5
    ? Math.min(99.9, Math.round(percent * 10) / 10)
    : Math.round(percent);
}

/** Working coverage includes source/target pairs that need no translation text. */
export function workingCoveredKeys(value: {
  totalKeys: number;
  translatedKeys: number;
  noTranslationNeededKeys?: number;
}): number {
  return Math.min(
    value.totalKeys,
    value.translatedKeys + (value.noTranslationNeededKeys ?? 0),
  );
}
