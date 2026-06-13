# Security Policy

## Supported Versions

Only the latest released version receives security fixes. There is no long-term
support branch.

| Version | Supported |
| ------- | --------- |
| 1.1.x   | ✅        |
| < 1.1   | ❌        |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately through one of these channels:

1. **GitHub Security Advisories** (preferred): open a private report via the
   repository's **Security → Report a vulnerability** tab.
2. **Email:** `[removed]` with `[SECURITY]` in the subject.

Please include:

- The application version (see **Settings → About**).
- Your Windows version.
- A description of the issue and its impact.
- Step-by-step reproduction, including any input files that trigger it.

You can expect an initial acknowledgement within **7 days** and a status update
within **30 days**. Coordinated disclosure is appreciated — please give a
reasonable window for a fix before any public discussion.

## Scope

This is a **fully local, portable Windows desktop app** with no accounts, no
telemetry, no cloud API keys, and no backend servers. The realistic threat
surface is therefore narrow:

**In scope**

- Memory-safety or logic bugs in the Rust backend
  ([`src-tauri/`](src-tauri/)) reachable from the Tauri command surface.
- Path-handling flaws (traversal, unintended writes/overwrites outside the
  selected folders) in scan, import, export, or glossary code.
- Parsing flaws when reading untrusted input: mod `i18n` JSON, unpacked game
  content, or returned LLM-batch result files.
- Improper handling of URLs opened via the system (`open_url`) or requests to a
  configured local-LLM endpoint.

**Out of scope**

- The executable being unsigned (Windows SmartScreen "unknown publisher"
  warning) — this is a known, documented limitation, not a vulnerability.
- Issues that require an attacker to already have write access to the user's
  machine, Mods folder, or the portable `Data/` folder.
- Vulnerabilities in third-party local LLM servers (Ollama, LM Studio, …) or in
  any external LLM service a user manually uploads a batch file to.
- Social-engineering, physical access, or denial of service caused by
  deliberately malformed local input the user themselves provided.

## Privacy Note

The app sends no data anywhere on its own. Local AI requests go only to the
endpoint you configure in **Settings → Local AI**. External LLM batches leave
your computer only when _you_ upload them to a service of your choice. See the
[README Privacy section](README.md#privacy) for details.
