const DISCOVERY_SOURCES = new Set(['search', 'schedule', 'home-boxing-tile']);

function configuredSurfacingName(eventData: Record<string, any>): string {
  return String(
    eventData.PPV_SURFACING_NAME ||
    eventData.global?.PPV_SURFACING_NAME ||
    '',
  ).trim();
}

export function resolveCanonicalPpvTitle(eventData: Record<string, any>): string {
  return String(eventData.PPV_NAME || eventData.PPV_DISPLAY_NAME || '').trim();
}

/**
 * Resolves the title rendered by a discovery card or its paywall. The optional
 * configuration is currently used only by AEW event configs; all other events
 * fall back to their existing canonical title unchanged.
 */
export function resolvePpvTitleForSurface(
  eventData: Record<string, any>,
  source: string,
  surface = '',
): string {
  const surfacingName = configuredSurfacingName(eventData);
  if (!surfacingName) return resolveCanonicalPpvTitle(eventData);

  const normalizedSource = String(source || '').trim().toLowerCase();
  const normalizedSurface = String(surface || '').trim().toLowerCase();
  const isPaywall = /paywall|popup/.test(normalizedSurface);

  return DISCOVERY_SOURCES.has(normalizedSource) || isPaywall
    ? surfacingName
    : resolveCanonicalPpvTitle(eventData);
}

export function resolvePpvTitleForSource(eventData: Record<string, any>, source: string): string {
  return resolvePpvTitleForSurface(eventData, source, 'PPV Tile');
}
