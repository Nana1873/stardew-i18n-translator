# Startup Auto-Scan Plan

## Scope

Automatically scan the configured Mods folder when the application starts and
the required setup values are already persisted.

## Behavior

- Complete setup means Stardew path, Mods path, and target language are set.
- A startup scan runs silently: the dashboard and Scan button show the existing
  scanning state, but no short-lived progress modal flashes.
- Warnings or errors open the existing Scan dialog for review.
- Manual Scan / Re-scan keeps its current visible progress dialog.
- First launch still opens the Setup Wizard and does not scan.

## Verification

- Configured startup invokes `scan_mods` exactly once with saved settings.
- Incomplete setup opens the wizard and never invokes the scanner.
- Clean startup results populate the dashboard without a dialog.
- Startup warnings and failures surface through the Scan dialog.
