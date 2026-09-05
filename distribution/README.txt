Stardew i18n Translator

START

1. Extract the complete ZIP to a writable folder, such as a folder under
   Documents. Do not run the application from inside the ZIP.
2. Open stardew-i18n-translator.exe. There is no installer.
3. Select your Stardew Valley folder, Mods folder, and target language, then scan.
4. Open a mod in Workspace, edit and review its strings, then export when ready.

The application works with SMAPI i18n/default.json translation sources. Saving
an edit keeps your work in the adjacent data folder; export is the separate
action that writes translation files to the selected mod.

REQUIREMENTS

Use 64-bit Windows with Microsoft Edge WebView2 Runtime. The executable is
unsigned, so Windows SmartScreen may show an unknown-publisher warning.
If WebView2 is missing, the application offers to open Microsoft's download
page before closing. Nothing is downloaded or installed automatically:
https://developer.microsoft.com/en-us/microsoft-edge/webview2/

UPDATE AND BACK UP

Read any release-specific upgrade notes before replacing your existing app:
https://github.com/Nana1873/stardew-i18n-translator/releases/latest

1. Close the application and back up its complete folder, including data.
2. Extract the new release ZIP to a separate application folder.
3. Copy the existing data folder beside the new stardew-i18n-translator.exe.
4. Start the new executable and check your folders, language, and saved work.
   Keep the backup until you have verified the update.

The data folder contains your settings, saved translation work, glossary caches,
and local diagnostics. Copy the complete application folder to move your work
to another computer. Select the Stardew Valley and Mods folders again if their
paths differ. Exported files in Mods are separate from this application backup.

PRIVACY AND OPTIONAL AI

Manual translation, scanning, validation, glossary building, and export run
locally. Local AI sends selected text, nearby source context, and matching
glossary terms to your configured local AI service. Codex CLI sends that context
through the installed CLI to its service, using the CLI's own login. The app
does not read its authentication files or tokens. External LLM batches leave
your computer when you upload them yourself. AI suggestions enter Review for
you to check.

HELP

User guide and project information:
https://github.com/Nana1873/stardew-i18n-translator

Report a problem with the app version, error message, and reproduction steps:
https://github.com/Nana1873/stardew-i18n-translator/issues

Settings > About opens the logs folder. Logs can contain local paths; remove
private information before sharing them.
