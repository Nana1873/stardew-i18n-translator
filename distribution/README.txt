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

- settings.json: selected folders, language, shortcuts, non-secret AI settings,
  and Workspace search, filter, sort, pane, and column-width preferences
- scan-source-snapshot.json: rebuildable source hashes from the latest complete
  Mods-folder scan, used to report changed, added, and removed English strings
- glossary/glossary-<lang>.json: optional per-language glossary caches
- language-state/<lang>/: saved translation work and automatic state backups
- logs/: optional rotating diagnostic logs

The five latest operation results and the single safe batch-undo snapshot are
kept only for the running application session. They are not written to the data
folder. Result details use the real paths and file names returned by the
backend; values the backend does not provide are shown as Unavailable.

Manual translation and local-only workflows remain offline. The optional Codex
CLI backend uses only the CLI's own login; the application never reads its
authentication files or tokens.

Optional Local AI translation sends selected source text, section context,
matching glossary terms, and up to two preceding and two following English
source strings from the same component, i18n file, section, and related key
group only to the loopback service configured in Settings. Neighboring strings
are read-only context: they cannot be returned as translations or saved. The
service-reported model list and non-secret endpoint settings are stored locally;
no API key or custom cloud endpoint is stored.

When Codex CLI translation is selected, the same bounded translation context is
sent through the installed CLI. Every AI result requires review before it
becomes an accepted translation.

Codex CLI runs use an additional language-quality and repair pass by default.
Settings can disable those extra calls to reduce time and token use. The app
shows a warning because first drafts may need more manual correction; validation
still runs and every result still enters Review.

Copy the complete application folder, including data, to move your work to
another computer.

The saved Stardew Valley and Mods paths are absolute and may need to be selected
again when the folder layout differs on the other computer.
