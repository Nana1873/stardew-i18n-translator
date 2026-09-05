# Troubleshooting

[User guide](user-guide.md) · [AI setup](ai.md) · [Project home](../README.md)

## The app does not start

Extract the entire portable ZIP before running the executable. Use a writable
folder because the app creates `data/` beside it. It cannot save work in a
read-only location.

The executable is unsigned, so Windows may display a SmartScreen warning.
Obtain it from the project's
[GitHub Releases](https://github.com/Nana1873/stardew-i18n-translator/releases/latest).
If Microsoft Edge WebView2 Runtime is missing, the native startup message offers
to open Microsoft's download page. Install the runtime and launch the app again.
The translator does not download or install it automatically.

## Updating and moving the app

1. Close the app before changing its files.
2. Back up the complete existing application folder, including `data/`.
3. Extract the new release ZIP into a separate folder. Copy your existing
   `data/` into the new folder beside `stardew-i18n-translator.exe`.
4. Start the new executable and check your language, folders, and saved work.
5. Keep the backup until you have verified the update.

To move to another computer, copy the complete application folder. Saved game
and Mods paths are absolute; select them again in Settings if the layout has
changed. Operation history and batch undo are session-only and do not move with
the saved translations.

## Recovering a backup

There are two different kinds of saved data:

- `data/` contains the translator's settings and unexported work. Back up the
  complete folder with the app closed. Restoring an old `data/` restores old work
  too, so keep a copy of the current folder before replacing it.
- An export creates backups beside existing mod translations, such as
  `i18n/de.json.bak`. A later export can replace that backup; it is not a full
  version history. To restore it, close the app, preserve the current target,
  and copy the `.bak` file back to the original `.json` name.

Restoring an exported file does not roll back saved work inside `data/`; a later
export can write those saved values again. Check the translator's current values
before exporting. For a consistent full rollback, restore matching backups of
both the app's data and affected mod translation files.

Corrupt settings can recover automatically from a valid `settings.json.bak`.
Translation-state errors identify the affected file: with the app closed, keep
the damaged file and restore its `.bak` sibling if available. If no usable
backup exists, report the error before deleting `data/` or starting over.

## A mod is missing or skipped

Check that you selected the correct Mods folder and that the mod uses
`i18n/default.json`. Content Patcher's `content.json`, arbitrary game data, and
XNB assets are not translation inputs. Community language packs can provide
glossary sources without appearing as translation targets.

Open the scan diagnostics for the specific reason a component was skipped.
Address that error and scan again. Source-change counts need complete scans;
they are unavailable after an incomplete scan rather than being guessed.

## Translation progress or export looks unexpected

Check the selected language, search scope, and filters first. **Has text** totals
can include Review entries; they do not mean every translation is accepted.
Existing target files load as Done, while external LLM imports enter Review.

Saving an edit updates `data/`; **Export…** writes it into the mod. Review and
Changed text can be exported after a warning. Empty translations are omitted so
the game can fall back to English. Target-only keys absent from English sources
are also omitted. See [export behavior](user-guide.md#export-translation-files).

For a blocked export, use **Open issue** in the confirmation to inspect an
affected string. Correct protected tokens or invalid text. Use **Save anyway**
only for an intentional token difference after checking its effect.

## Glossary or AI is unavailable

An unavailable glossary does not block translation. Check your game folder and
the source explanation in **Settings > Glossary**. Custom languages need a
compatible installed pack with local Strings sources for glossary generation.

For Local AI, start the service, load a supported model, check the loopback URL,
and test again. For Codex CLI, follow the error shown by **Check status**; lack
of usage-limit data alone does not make the engine unusable. See the
[AI guide](ai.md) for setup, quality options, and interrupted runs.

## Report a problem

Use the [bug form](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=bug_report.yml).
Include the app version from **Settings > About**, what you expected, what
happened, and a few steps to reproduce it. A screenshot or small synthetic
example is helpful; a short report is enough.

Logs can be opened from **Settings > About**. General diagnostic entries can
contain local paths, so remove private information before attaching them.
Never include credentials, Codex authentication files, or a full copy of your
game or Mods folder.
