/** CSS animation adds no log entries or repeated live-region announcements. */
export function WorkingDots() {
  return (
    <span className="desktop-working-dots" role="img" aria-label="In progress">
      <span aria-hidden="true">.</span>
      <span aria-hidden="true">.</span>
      <span aria-hidden="true">.</span>
    </span>
  );
}
