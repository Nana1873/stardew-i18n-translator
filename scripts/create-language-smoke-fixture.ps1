param(
    [string]$OutputRoot = (Join-Path (Split-Path $PSScriptRoot -Parent) "target\language-smoke")
)

$ErrorActionPreference = "Stop"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$gamePath = Join-Path $OutputRoot "Stardew Valley"
$modsPath = Join-Path $gamePath "Mods"
$modPath = Join-Path $modsPath "Synthetic Language Test"
$i18nPath = Join-Path $modPath "i18n"
$resultsPath = Join-Path $OutputRoot "LLM Results"

New-Item -ItemType Directory -Force -Path (Join-Path $gamePath "Content") | Out-Null
New-Item -ItemType Directory -Force -Path $i18nPath | Out-Null
New-Item -ItemType Directory -Force -Path $resultsPath | Out-Null

function Decode-Utf8 {
    param([string]$Base64)
    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Base64))
}

function Write-Utf8Json {
    param(
        [string]$Path,
        [System.Collections.IDictionary]$Value
    )

    $json = $Value | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($Path, "$json`n", $utf8NoBom)
}

Write-Utf8Json (Join-Path $modPath "manifest.json") ([ordered]@{
    Name = "Synthetic Language Test"
    Author = "Stardew i18n Translator"
    Version = "1.0.0"
    UniqueID = "Nana1873.LanguageSmoke"
})

Write-Utf8Json (Join-Path $i18nPath "default.json") ([ordered]@{
    greeting = "Hello {{PlayerName}}!"
    weather = Decode-Utf8 "Q2Fmw6kgd2VhdGhlcg=="
})

$translations = [ordered]@{
    "de.json" = "SGFsbG8ge3tQbGF5ZXJOYW1lfX0sIHNjaMO2bmVuIFRhZyE="
    "es.json" = "wqFIb2xhLCB7e1BsYXllck5hbWV9fSEgUXXDqSBhbGVncsOtYS4="
    "fr.json" = "Qm9uam91ciwge3tQbGF5ZXJOYW1lfX0uIEzigJnDqXTDqSBhcnJpdmUu"
    "hu.json" = "U3ppYSwge3tQbGF5ZXJOYW1lfX0hIMWQcml6ZCBhIHTFsXpldC4="
    "it.json" = "Q2lhbywge3tQbGF5ZXJOYW1lfX0uIENvbeKAmcOoIGJlbGxvLg=="
    "ja.json" = "44GT44KT44Gr44Gh44Gv44CBe3tQbGF5ZXJOYW1lfX3jgILku4rml6Xjga/jgYTjgYTml6XjgafjgZnjgII="
    "ko.json" = "7JWI64WV7ZWY7IS47JqULCB7e1BsYXllck5hbWV9fS4g7KKL7J2AIO2VmOujqOyYiOyalC4="
    "pt-BR.json" = "T2zDoSwge3tQbGF5ZXJOYW1lfX0uIFF1ZSDDs3RpbW8h"
    "ru.json" = "0J/RgNC40LLQtdGCLCB7e1BsYXllck5hbWV9fS4g0KXQvtGA0L7RiNC10LPQviDQtNC90Y8h"
    "tr.json" = "TWVyaGFiYSwge3tQbGF5ZXJOYW1lfX0uIElsxLFrIMSxxZ/EsWsgZ8O8emVsLg=="
    "zh.json" = "5L2g5aW977yMe3tQbGF5ZXJOYW1lfX3jgILku4rlpKnnnJ/lpb3jgII="
}

foreach ($entry in $translations.GetEnumerator()) {
    $translation = Decode-Utf8 $entry.Value
    Write-Utf8Json (Join-Path $i18nPath $entry.Key) ([ordered]@{
        greeting = $translation
    })

    $languageCode = $entry.Key.Split(".")[0]
    if ($languageCode -eq "pt-BR") {
        $languageCode = "pt"
    }
    Write-Utf8Json (Join-Path $resultsPath "$languageCode-result.json") ([ordered]@{
        format = "stardew-translator-llm-result"
        version = 1
        files = [ordered]@{
            i18n = [ordered]@{
                weather = Decode-Utf8 "Q2Fmw6k="
            }
        }
    })
}

Write-Host "Synthetic language smoke fixture created."
Write-Host "Stardew path: $gamePath"
Write-Host "Mods path:    $modsPath"
Write-Host "LLM results:  $resultsPath"
Write-Host "Portuguese intentionally uses pt-BR.json; export should create pt.json."
