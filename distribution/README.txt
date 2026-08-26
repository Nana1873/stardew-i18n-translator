Stardew i18n Translator portable installation

Keep this README beside stardew-i18n-translator.exe.

The application requires Microsoft Edge WebView2 Runtime. It is included with
Windows 11 and most Windows 10 installations. If it is missing, the executable
shows a native Windows message before the application UI starts. Choose Yes to
open Microsoft's official download page, or No to close the application.
Nothing is downloaded or installed automatically.

https://developer.microsoft.com/en-us/microsoft-edge/webview2/

The application creates a data folder beside the executable on first launch.
It stores local data there:

- settings.json: selected folders, language, shortcuts, and non-secret AI
  settings
- glossary/glossary-<lang>.json: optional per-language glossary caches
- language-state/<lang>/: saved translation work and automatic state backups
- logs/: optional rotating diagnostic logs

Manual translation and local-only workflows remain offline. The optional Codex
CLI backend uses only the CLI's own login; the application never reads its
authentication files or tokens. An OpenAI API key is kept only in the running
application process and is never written to the data folder.

When Codex CLI or OpenAI API translation is selected, source text, section
context, and matching glossary terms are sent to that service. The OpenAI API
backend uses the fixed official Responses API with store=false and no tools;
its use can incur separate API costs. Every AI result requires review before it
becomes an accepted translation.

Copy the complete application folder, including data, to move your work to
another computer.

The saved Stardew Valley and Mods paths are absolute and may need to be selected
again when the folder layout differs on the other computer.
