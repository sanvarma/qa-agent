/**
 * Resolves the URL the agent should navigate to for selector discovery.
 *
 * Override this function when adapting to a framework with different URL
 * routing conventions (e.g. subdomain-per-locale, query-param locale, etc.)
 *
 * Current convention (path-based routing):
 *   generic / global  → baseUrl as-is  (app routes to its default locale)
 *   ['es-pr', ...]    → baseUrl/es-pr  (first locale in array)
 *   'es-pr'           → baseUrl/es-pr
 */
export function resolveBrowseUrl(
  baseUrl: string,
  localeScope: string | string[],
): string {
  const base = baseUrl.replace(/\/$/, '');

  if (localeScope === 'generic' || localeScope === 'global') {
    return base;
  }

  if (Array.isArray(localeScope)) {
    if (localeScope.length === 0) return base;
    return `${base}/${localeScope[0]}`;
  }

  return `${base}/${localeScope}`;
}
