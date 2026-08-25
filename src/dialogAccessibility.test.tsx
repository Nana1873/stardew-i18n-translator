import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { useDialogAccessibility } from "./dialogAccessibility";

function TestDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onClose,
  });
  return (
    <div data-testid="overlay">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        onKeyDown={onDialogKeyDown}
      >
        <button type="button">First</button>
        <button type="button">Last</button>
      </section>
    </div>
  );
}

describe("dialog accessibility", () => {
  it("isolates every sibling layer and restores it when the modal unmounts", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <div id="stv3-dense-demo">
        <button type="button">Command bar</button>
        <main>
          <button type="button">Workbench</button>
          <TestDialog onClose={onClose} />
        </main>
      </div>,
    );

    const commandBar = screen.getByText("Command bar");
    const workbench = screen.getByText("Workbench");
    expect(commandBar).toHaveAttribute("aria-hidden", "true");
    expect(workbench).toHaveAttribute("aria-hidden", "true");
    expect(commandBar.inert).toBe(true);
    expect(workbench.inert).toBe(true);

    rerender(
      <div id="stv3-dense-demo">
        <button type="button">Command bar</button>
        <main>
          <button type="button">Workbench</button>
        </main>
      </div>,
    );

    expect(
      screen.getByRole("button", { name: "Command bar" }),
    ).not.toHaveAttribute("aria-hidden");
    expect(
      screen.getByRole("button", { name: "Workbench" }),
    ).not.toHaveAttribute("aria-hidden");
  });

  it("traps Tab and handles Escape inside the active layer", () => {
    const onClose = vi.fn();
    render(
      <div id="stv3-dense-demo">
        <TestDialog onClose={onClose} />
      </div>,
    );

    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
