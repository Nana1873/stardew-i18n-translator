# Test Fixtures

This directory contains static mock fixtures for testing parser logic, directory scans, and token validators.

> [!CAUTION]
> Do NOT store real game data, real mod code, or user credentials here. Keep fixtures minimal and generic.

## Expected Directory Structure
* `mods-scan/` - Mock mods directory containing `manifest.json` files of varying validity.
* `i18n-import/` - Sample translations containing standard and corrupted JSON formats.
* `batch-files/` - Sample import/export translation batch files.
