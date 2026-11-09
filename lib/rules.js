export function hostnameFromUrl(value) {
  if (!value) return "";

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

export function normalizeDomain(value) {
  if (!value) return "";
  const input = value.trim().toLowerCase();
  return hostnameFromUrl(input.includes("://") ? input : `https://${input}`);
}

export function domainMatches(hostname, configuredDomain) {
  const host = normalizeDomain(hostname);
  const rule = normalizeDomain(configuredDomain);
  return Boolean(host && rule && (host === rule || host.endsWith(`.${rule}`)));
}

export function isSameSite(firstHostname, secondHostname) {
  return (
    domainMatches(firstHostname, secondHostname) ||
    domainMatches(secondHostname, firstHostname)
  );
}

export function isProtectedSource(sourceUrl, settings) {
  const sourceHost = hostnameFromUrl(sourceUrl);
  if (!sourceHost || !settings.enabled) return false;
  if (settings.protectAll) return true;
  return settings.protectedSites.some((domain) => domainMatches(sourceHost, domain));
}

function isBrowserInternalUrl(value) {
  return /^(chrome|chrome-extension|edge|devtools|file):/i.test(value || "");
}

export function classifyCandidate({ sourceUrl, destinationUrl, gesture, settings }) {
  const sourceHost = hostnameFromUrl(sourceUrl);

  if (!isProtectedSource(sourceUrl, settings)) {
    return { shouldClose: false, reason: "source-not-protected" };
  }

  if (gesture?.explicitNewTab && settings.allowIntentionalNewTabs) {
    return { shouldClose: false, reason: "intentional-new-tab" };
  }

  if (isBrowserInternalUrl(destinationUrl)) {
    return { shouldClose: false, reason: "browser-internal-page" };
  }

  const destinationHost = hostnameFromUrl(destinationUrl);
  if (!destinationHost) {
    return {
      shouldClose: true,
      reason: "unexpected-unresolved-tab",
      sourceHost,
      destinationHost: ""
    };
  }

  if (settings.allowedDomains.some((domain) => domainMatches(destinationHost, domain))) {
    return { shouldClose: false, reason: "destination-allowed" };
  }

  if (isSameSite(sourceHost, destinationHost)) {
    return { shouldClose: false, reason: "same-site-tab" };
  }

  return {
    shouldClose: true,
    reason: "unexpected-cross-site-tab",
    sourceHost,
    destinationHost
  };
}
