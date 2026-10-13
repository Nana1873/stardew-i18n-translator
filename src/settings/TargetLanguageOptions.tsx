/**
 * Target-language options grouped by whether the game includes the language,
 * shared by Settings and the setup.
 */
import { TARGET_LANGUAGES, gameSupportsLanguage } from "../languages";

const GROUPS = [
  { label: "In the game", inGame: true },
  { label: "Needs a language mod in the game", inGame: false },
] as const;

export function TargetLanguageOptions() {
  return (
    <>
      <option value="" disabled>
        Choose a language…
      </option>
      {GROUPS.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {TARGET_LANGUAGES.filter(
            (language) => gameSupportsLanguage(language.code) === group.inGame,
          ).map((language) => (
            <option key={language.code} value={language.code}>
              {language.label}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
