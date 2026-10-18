export const CURATED_CATALOG_URL =
  "https://wchao6891.github.io/PromptDirector-Curated/public-catalog.json";

export const CURATED_METRICS_URL =
  "https://wchao6891.github.io/PromptDirector-Curated/metrics.json";

export const CURATED_PUBLIC_SITE_URL =
  "https://wchao6891.github.io/PromptDirector-Curated/";

export const CURATED_SUBMISSION_URL =
  "https://github.com/wchao6891/PromptDirector-Curated/issues/new?template=curated-submission.yml";

export const CURATED_SKILL_CATALOG_URL =
  "https://wchao6891.github.io/PromptDirector-Curated/skills-catalog.json";

export const CURATED_SKILL_SUBMISSION_URL =
  "https://github.com/wchao6891/PromptDirector-Curated/issues/new?template=curated-skill-submission.yml";

export const CURATED_PERMISSION_ORIGINS = Object.freeze([
  "https://wchao6891.github.io/*",
  "https://github.com/*",
  "https://objects.githubusercontent.com/*",
  "https://release-assets.githubusercontent.com/*"
]);

// Public navigation follows the chosen UI language without changing catalog or ZIP URLs.
export function curatedPublicUrl(locale, page = "", params = {}) {
  const language = locale === "en" ? "en" : "zh-CN";
  const url = new URL(`${language === "en" ? "en/" : ""}${page}`, CURATED_PUBLIC_SITE_URL);
  url.searchParams.set("lang", language);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

export function curatedSubmissionUrl(locale, kind = "cases") {
  const url = new URL(kind === "skills" ? CURATED_SKILL_SUBMISSION_URL : CURATED_SUBMISSION_URL);
  if (locale === "en") url.searchParams.set("template", url.searchParams.get("template").replace(".yml", "-en.yml"));
  return url.href;
}
