import type { ZipPreview } from "../tauri/commands";

export interface ReleaseNotesResult {
  text: string;
  actualLanguage: string;
  fellBackToEnglish: boolean;
}

interface ReleaseTemplate {
  locale: string;
  languageName: string;
  title: (language: string, packageName: string, version: string) => string;
  ready: string;
  notReady: (count: string) => string;
  labels: {
    status: string;
    language: string;
    generated: string;
    archive: string;
    coverage: string;
    components: string;
    review: string;
    outdated: string;
    needsReview: string;
    installation: string;
    compatibility: string;
  };
  installation: string;
  compatibility: (packageName: string, version: string) => string;
}

const templates: Record<string, ReleaseTemplate> = {
  en: {
    locale: "en-US",
    languageName: "English",
    title: (language, packageName, version) =>
      `${language} translation for ${packageName} ${version}`,
    ready: "Ready to release",
    notReady: (count) => `Not release-ready: ${count} blocking problem(s)`,
    labels: {
      status: "Status",
      language: "Language",
      generated: "Generated",
      archive: "Archive",
      coverage: "Coverage",
      components: "Included components",
      review: "Review state",
      outdated: "Outdated strings",
      needsReview: "Needs review",
      installation: "Installation",
      compatibility: "Compatibility",
    },
    installation:
      "Install the ZIP with Vortex, or extract it into your Stardew Valley Mods folder and allow the translation files to overlay the matching mod folders.",
    compatibility: (packageName, version) =>
      `Prepared against ${packageName} ${version}. This translation may continue to work with later mod versions because missing new translation keys fall back to default.json. An update may still be needed when existing text, protected tokens, component paths, or the i18n file structure changes. Update the original mod separately and check the translation status afterward.`,
  },
  de: {
    locale: "de-DE",
    languageName: "Deutsch",
    title: (language, packageName, version) =>
      `${language}e Übersetzung für ${packageName} ${version}`,
    ready: "Bereit zur Veröffentlichung",
    notReady: (count) =>
      `Nicht veröffentlichungsbereit: ${count} blockierende Probleme`,
    labels: {
      status: "Status",
      language: "Sprache",
      generated: "Erstellt",
      archive: "Archiv",
      coverage: "Abdeckung",
      components: "Enthaltene Komponenten",
      review: "Prüfstatus",
      outdated: "Veraltete Texte",
      needsReview: "Noch zu prüfen",
      installation: "Installation",
      compatibility: "Kompatibilität",
    },
    installation:
      "Installiere die ZIP mit Vortex oder entpacke sie in deinen Stardew-Valley-Mods-Ordner. Die Übersetzungsdateien dürfen dabei die passenden Mod-Ordner überlagern.",
    compatibility: (packageName, version) =>
      `Erstellt für ${packageName} ${version}. Die Übersetzung kann mit neueren Mod-Versionen weiter funktionieren, da neue, noch nicht übersetzte Schlüssel auf default.json zurückfallen. Bei geänderten Texten, geschützten Tokens, Komponentenpfaden oder der i18n-Dateistruktur kann trotzdem ein Update nötig sein. Aktualisiere die Original-Mod separat und prüfe danach den Übersetzungsstatus.`,
  },
  es: {
    locale: "es-ES",
    languageName: "Español",
    title: (language, packageName, version) =>
      `Traducción al ${language} para ${packageName} ${version}`,
    ready: "Lista para publicar",
    notReady: (count) =>
      `No está lista para publicar: ${count} problemas bloqueantes`,
    labels: {
      status: "Estado",
      language: "Idioma",
      generated: "Generado",
      archive: "Archivo",
      coverage: "Cobertura",
      components: "Componentes incluidos",
      review: "Estado de revisión",
      outdated: "Textos desactualizados",
      needsReview: "Pendientes de revisión",
      installation: "Instalación",
      compatibility: "Compatibilidad",
    },
    installation:
      "Instala el ZIP con Vortex o extráelo en la carpeta Mods de Stardew Valley y permite que los archivos de traducción se superpongan a las carpetas correspondientes del mod.",
    compatibility: (packageName, version) =>
      `Preparada para ${packageName} ${version}. La traducción puede seguir funcionando con versiones posteriores porque las claves nuevas sin traducir usan default.json como alternativa. Aun así, puede requerir una actualización si cambian textos existentes, tokens protegidos, rutas de componentes o la estructura i18n. Actualiza el mod original por separado y revisa después el estado de la traducción.`,
  },
  fr: {
    locale: "fr-FR",
    languageName: "Français",
    title: (language, packageName, version) =>
      `Traduction ${language}e pour ${packageName} ${version}`,
    ready: "Prête à publier",
    notReady: (count) => `Pas prête à publier : ${count} problèmes bloquants`,
    labels: {
      status: "État",
      language: "Langue",
      generated: "Généré",
      archive: "Archive",
      coverage: "Couverture",
      components: "Composants inclus",
      review: "État de la révision",
      outdated: "Textes obsolètes",
      needsReview: "À vérifier",
      installation: "Installation",
      compatibility: "Compatibilité",
    },
    installation:
      "Installez le ZIP avec Vortex ou extrayez-le dans le dossier Mods de Stardew Valley en autorisant les fichiers de traduction à se superposer aux dossiers correspondants du mod.",
    compatibility: (packageName, version) =>
      `Préparée pour ${packageName} ${version}. La traduction peut continuer à fonctionner avec des versions ultérieures, car les nouvelles clés non traduites utilisent default.json comme solution de repli. Une mise à jour peut néanmoins être nécessaire si des textes existants, des jetons protégés, des chemins de composants ou la structure i18n changent. Mettez le mod d'origine à jour séparément, puis vérifiez l'état de la traduction.`,
  },
  hu: {
    locale: "hu-HU",
    languageName: "Magyar",
    title: (language, packageName, version) =>
      `${language} fordítás ehhez: ${packageName} ${version}`,
    ready: "Kiadásra kész",
    notReady: (count) => `Nem kiadásra kész: ${count} blokkoló probléma`,
    labels: {
      status: "Állapot",
      language: "Nyelv",
      generated: "Készült",
      archive: "Archívum",
      coverage: "Lefedettség",
      components: "Tartalmazott összetevők",
      review: "Ellenőrzési állapot",
      outdated: "Elavult szövegek",
      needsReview: "Ellenőrzendő",
      installation: "Telepítés",
      compatibility: "Kompatibilitás",
    },
    installation:
      "Telepítsd a ZIP-et Vortexszel, vagy csomagold ki a Stardew Valley Mods mappájába, és engedd, hogy a fordítási fájlok a megfelelő modmappákra kerüljenek.",
    compatibility: (packageName, version) =>
      `A(z) ${packageName} ${version} verziójához készült. A fordítás újabb verziókkal is működhet, mert az új, még nem fordított kulcsok a default.json szövegére esnek vissza. Frissítésre lehet szükség, ha meglévő szövegek, védett tokenek, összetevőútvonalak vagy az i18n szerkezete változik. Az eredeti modot külön frissítsd, majd ellenőrizd a fordítás állapotát.`,
  },
  it: {
    locale: "it-IT",
    languageName: "Italiano",
    title: (language, packageName, version) =>
      `Traduzione in ${language} per ${packageName} ${version}`,
    ready: "Pronta per la pubblicazione",
    notReady: (count) =>
      `Non pronta per la pubblicazione: ${count} problemi bloccanti`,
    labels: {
      status: "Stato",
      language: "Lingua",
      generated: "Generato",
      archive: "Archivio",
      coverage: "Copertura",
      components: "Componenti inclusi",
      review: "Stato revisione",
      outdated: "Testi obsoleti",
      needsReview: "Da rivedere",
      installation: "Installazione",
      compatibility: "Compatibilità",
    },
    installation:
      "Installa lo ZIP con Vortex oppure estrailo nella cartella Mods di Stardew Valley, consentendo ai file di traduzione di sovrapporsi alle cartelle corrispondenti della mod.",
    compatibility: (packageName, version) =>
      `Preparata per ${packageName} ${version}. La traduzione potrebbe continuare a funzionare con versioni successive perché le nuove chiavi non tradotte usano default.json come ripiego. Potrebbe comunque servire un aggiornamento se cambiano testi esistenti, token protetti, percorsi dei componenti o la struttura i18n. Aggiorna separatamente la mod originale e poi controlla lo stato della traduzione.`,
  },
  ja: {
    locale: "ja-JP",
    languageName: "日本語",
    title: (language, packageName, version) =>
      `${packageName} ${version} ${language}翻訳`,
    ready: "公開準備完了",
    notReady: (count) => `公開準備未完了: ブロック中の問題 ${count} 件`,
    labels: {
      status: "状態",
      language: "言語",
      generated: "生成日",
      archive: "アーカイブ",
      coverage: "翻訳率",
      components: "含まれるコンポーネント",
      review: "レビュー状態",
      outdated: "古い翻訳",
      needsReview: "要レビュー",
      installation: "インストール",
      compatibility: "互換性",
    },
    installation:
      "VortexでZIPをインストールするか、Stardew ValleyのModsフォルダーへ展開し、翻訳ファイルを対応するModフォルダーへ上書きしてください。",
    compatibility: (packageName, version) =>
      `${packageName} ${version}向けに作成されています。新しい未翻訳キーはdefault.jsonへフォールバックするため、後のModバージョンでも動作する場合があります。ただし、既存テキスト、保護トークン、コンポーネントのパス、i18n構造が変わった場合は更新が必要です。元のModは別に更新し、その後で翻訳状態を確認してください。`,
  },
  ko: {
    locale: "ko-KR",
    languageName: "한국어",
    title: (language, packageName, version) =>
      `${packageName} ${version} ${language} 번역`,
    ready: "배포 준비 완료",
    notReady: (count) => `배포 준비 안 됨: 차단 문제 ${count}개`,
    labels: {
      status: "상태",
      language: "언어",
      generated: "생성일",
      archive: "압축 파일",
      coverage: "번역률",
      components: "포함된 구성 요소",
      review: "검토 상태",
      outdated: "오래된 번역",
      needsReview: "검토 필요",
      installation: "설치",
      compatibility: "호환성",
    },
    installation:
      "Vortex로 ZIP을 설치하거나 Stardew Valley Mods 폴더에 압축을 풀고 번역 파일이 해당 모드 폴더에 덮어써지도록 허용하세요.",
    compatibility: (packageName, version) =>
      `${packageName} ${version}을 기준으로 준비되었습니다. 새 번역 키가 없으면 default.json으로 대체되므로 이후 모드 버전에서도 작동할 수 있습니다. 기존 문구, 보호 토큰, 구성 요소 경로 또는 i18n 구조가 바뀌면 번역 업데이트가 필요할 수 있습니다. 원본 모드는 별도로 업데이트한 뒤 번역 상태를 확인하세요.`,
  },
  pt: {
    locale: "pt-BR",
    languageName: "Português",
    title: (language, packageName, version) =>
      `Tradução em ${language} para ${packageName} ${version}`,
    ready: "Pronta para publicação",
    notReady: (count) =>
      `Não está pronta para publicação: ${count} problemas bloqueadores`,
    labels: {
      status: "Status",
      language: "Idioma",
      generated: "Gerado",
      archive: "Arquivo",
      coverage: "Cobertura",
      components: "Componentes incluídos",
      review: "Status da revisão",
      outdated: "Textos desatualizados",
      needsReview: "Precisam de revisão",
      installation: "Instalação",
      compatibility: "Compatibilidade",
    },
    installation:
      "Instale o ZIP com o Vortex ou extraia-o na pasta Mods do Stardew Valley e permita que os arquivos de tradução sejam sobrepostos às pastas correspondentes do mod.",
    compatibility: (packageName, version) =>
      `Preparada para ${packageName} ${version}. A tradução pode continuar funcionando em versões posteriores, pois novas chaves sem tradução usam default.json como alternativa. Ainda pode ser necessária uma atualização se textos existentes, tokens protegidos, caminhos de componentes ou a estrutura i18n mudarem. Atualize o mod original separadamente e depois verifique o status da tradução.`,
  },
  ru: {
    locale: "ru-RU",
    languageName: "Русский",
    title: (language, packageName, version) =>
      `Перевод на ${language} для ${packageName} ${version}`,
    ready: "Готово к публикации",
    notReady: (count) =>
      `Не готово к публикации: блокирующих проблем — ${count}`,
    labels: {
      status: "Статус",
      language: "Язык",
      generated: "Создано",
      archive: "Архив",
      coverage: "Покрытие",
      components: "Включённые компоненты",
      review: "Состояние проверки",
      outdated: "Устаревшие строки",
      needsReview: "Требуют проверки",
      installation: "Установка",
      compatibility: "Совместимость",
    },
    installation:
      "Установите ZIP через Vortex или распакуйте его в папку Mods Stardew Valley, разрешив файлам перевода наложиться на соответствующие папки мода.",
    compatibility: (packageName, version) =>
      `Подготовлено для ${packageName} ${version}. Перевод может работать и с более поздними версиями: для новых непереведённых ключей используется default.json. Однако обновление может потребоваться при изменении существующего текста, защищённых токенов, путей компонентов или структуры i18n. Обновляйте исходный мод отдельно и затем проверяйте состояние перевода.`,
  },
  tr: {
    locale: "tr-TR",
    languageName: "Türkçe",
    title: (language, packageName, version) =>
      `${packageName} ${version} için ${language} çeviri`,
    ready: "Yayınlamaya hazır",
    notReady: (count) => `Yayınlamaya hazır değil: ${count} engelleyici sorun`,
    labels: {
      status: "Durum",
      language: "Dil",
      generated: "Oluşturulma",
      archive: "Arşiv",
      coverage: "Kapsam",
      components: "Dahil edilen bileşenler",
      review: "İnceleme durumu",
      outdated: "Eski metinler",
      needsReview: "İncelenecek",
      installation: "Kurulum",
      compatibility: "Uyumluluk",
    },
    installation:
      "ZIP dosyasını Vortex ile kurun veya Stardew Valley Mods klasörüne çıkarıp çeviri dosyalarının eşleşen mod klasörlerinin üzerine yazılmasına izin verin.",
    compatibility: (packageName, version) =>
      `${packageName} ${version} temel alınarak hazırlanmıştır. Yeni çevrilmemiş anahtarlar default.json dosyasına geri döndüğü için sonraki mod sürümlerinde çalışmaya devam edebilir. Mevcut metinler, korumalı belirteçler, bileşen yolları veya i18n yapısı değişirse güncelleme gerekebilir. Orijinal modu ayrı olarak güncelleyin ve ardından çeviri durumunu kontrol edin.`,
  },
  zh: {
    locale: "zh-CN",
    languageName: "中文",
    title: (language, packageName, version) =>
      `${packageName} ${version} ${language}翻译`,
    ready: "可以发布",
    notReady: (count) => `尚不可发布：${count} 个阻止问题`,
    labels: {
      status: "状态",
      language: "语言",
      generated: "生成日期",
      archive: "压缩包",
      coverage: "覆盖率",
      components: "包含的组件",
      review: "审核状态",
      outdated: "过时文本",
      needsReview: "需要审核",
      installation: "安装",
      compatibility: "兼容性",
    },
    installation:
      "使用 Vortex 安装 ZIP，或将其解压到 Stardew Valley 的 Mods 文件夹，并允许翻译文件覆盖对应的模组文件夹。",
    compatibility: (packageName, version) =>
      `基于 ${packageName} ${version} 制作。新的未翻译键会回退到 default.json，因此本翻译可能仍适用于后续模组版本。但如果现有文本、受保护的令牌、组件路径或 i18n 文件结构发生变化，仍可能需要更新。请单独更新原模组，然后检查翻译状态。`,
  },
};

function componentLines(preview: ZipPreview): string[] {
  const components = new Map<string, { version: string; paths: string[] }>();
  for (const entry of preview.entries) {
    const key = `${entry.modName}\u0000${entry.modVersion}`;
    const component = components.get(key) ?? {
      version: entry.modVersion,
      paths: [],
    };
    component.paths.push(entry.archivePath);
    components.set(key, component);
  }
  return [...components.entries()].map(([key, component]) => {
    const name = key.split("\u0000", 1)[0];
    return `- ${name} ${component.version} (${component.paths.join(", ")})`;
  });
}

function conciseCompatibility(text: string): string {
  const terminator = text.includes("。") ? "。" : ".";
  const withoutFinalTerminator = text.endsWith(terminator)
    ? text.slice(0, -terminator.length)
    : text;
  const finalSentenceStart = withoutFinalTerminator.lastIndexOf(terminator);
  return finalSentenceStart === -1
    ? text
    : withoutFinalTerminator.slice(0, finalSentenceStart + terminator.length);
}

export function generateReleaseNotes(
  preview: ZipPreview,
  advertisedVersion: string,
  archiveFileName: string | null,
  outputLanguage: string,
  generatedAt = new Date(),
): ReleaseNotesResult {
  const template = templates[outputLanguage] ?? templates.en;
  const fellBackToEnglish = !templates[outputLanguage];
  const number = new Intl.NumberFormat(template.locale);
  const date = new Intl.DateTimeFormat(template.locale, {
    dateStyle: "long",
  }).format(generatedAt);
  const translated = preview.totalStrings;
  const total = preview.totalSourceStrings;
  const percentage = total === 0 ? 0 : (translated / total) * 100;
  const percentageText = new Intl.NumberFormat(template.locale, {
    maximumFractionDigits: 1,
  }).format(percentage);
  const outdated = preview.entries.reduce(
    (sum, entry) => sum + entry.outdated,
    0,
  );
  const reviewNeeded = preview.entries.reduce(
    (sum, entry) => sum + entry.reviewNeeded,
    0,
  );
  const problemCount = preview.problems.length;
  const language =
    outputLanguage === "en" ? preview.targetLanguage : template.languageName;
  const status =
    problemCount === 0
      ? template.ready
      : template.notReady(number.format(problemCount));
  const lines = [
    template.title(language, preview.packageName, advertisedVersion),
    "",
    `${template.labels.status}: ${status}`,
    `${template.labels.language}: ${language} (${preview.targetLang}) · ${template.labels.coverage}: ${number.format(translated)} / ${number.format(total)} (${percentageText}%)`,
    `${template.labels.generated}: ${date}`,
  ];
  if (archiveFileName) {
    lines.push(`${template.labels.archive}: ${archiveFileName}`);
  }
  lines.push("", `${template.labels.components}:`, ...componentLines(preview));
  if (outdated > 0 || reviewNeeded > 0) {
    lines.push(
      `${template.labels.review}: ${template.labels.outdated} ${number.format(outdated)} · ${template.labels.needsReview} ${number.format(reviewNeeded)}`,
    );
  }
  lines.push(
    "",
    `${template.labels.installation}: ${template.installation}`,
    "",
    `${template.labels.compatibility}: ${conciseCompatibility(
      template.compatibility(preview.packageName, advertisedVersion),
    )}`,
  );
  return {
    text: lines.join("\n"),
    actualLanguage: fellBackToEnglish ? "en" : outputLanguage,
    fellBackToEnglish,
  };
}

export function hasReleaseTemplate(language: string): boolean {
  return Boolean(templates[language]);
}
