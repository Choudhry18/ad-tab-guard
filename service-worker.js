import {
  classifyCandidate,
  hostnameFromUrl
} from "./lib/rules.js";

const DEFAULT_SETTINGS = {
  enabled: true,
  protectAll: false,
  retryClicks: true,
  allowIntentionalNewTabs: false,
  protectedSites: [],
  allowedDomains: [],
  closedCount: 0,
  closedEvents: []
};

const CANDIDATE_DELAY_MS = 450;
const GESTURE_WINDOW_MS = 1500;
const CONTEXT_LINK_WINDOW_MS = 30_000;
const MAX_LOG_ENTRIES = 100;

const recentGestures = new Map();
const contextLinks = new Map();
const candidates = new Map();
const retriedGestures = new Set();
const navigationQueues = new Map();

async function getSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

async function updateBadge(count) {
  await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
  await chrome.action.setBadgeText({
    text: count > 999 ? "999+" : count ? String(count) : ""
  });
  await chrome.action.setTitle({ title: `Ad Tab Guard — ${count} tab${count === 1 ? "" : "s"} closed` });
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await chrome.storage.local.set(settings);
  await updateBadge(settings.closedCount);
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  await updateBadge(settings.closedCount);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;
  if (tabId == null) return;

  if (message?.type === "context-link") {
    contextLinks.delete(tabId);
    recentGestures.delete(tabId);
    if (sender.tab.active && typeof message.url === "string" && hostnameFromUrl(message.url)) {
      contextLinks.set(tabId, {
        url: message.url,
        sourceUrl: sender.tab.url,
        windowId: sender.tab.windowId,
        openedAt: Date.now()
      });
    }
  }

  if (message?.type === "gesture") {
    contextLinks.delete(tabId);
    const gesture = {
      ...message.gesture,
      tabId: sender.tab.id,
      windowId: sender.tab.windowId,
      receivedAt: Date.now()
    };

    recentGestures.set(sender.tab.id, gesture);
    setTimeout(() => {
      if (recentGestures.get(sender.tab.id) === gesture) {
        recentGestures.delete(sender.tab.id);
      }
    }, GESTURE_WINDOW_MS + 250);
  }
});

function findRecentGesture(windowId, preferredTabId) {
  const now = Date.now();

  if (preferredTabId != null) {
    const preferred = recentGestures.get(preferredTabId);
    if (preferred && now - preferred.receivedAt <= GESTURE_WINDOW_MS) return preferred;
  }

  return [...recentGestures.values()]
    .filter(
      (gesture) =>
        gesture.windowId === windowId && now - gesture.receivedAt <= GESTURE_WINDOW_MS
    )
    .sort((a, b) => b.receivedAt - a.receivedAt)[0];
}

chrome.tabs.onCreated.addListener((tab) => {
  void registerCandidate(tab);
});

async function registerCandidate(tab) {
  const gesture = findRecentGesture(tab.windowId, tab.openerTabId);
  const sourceTabId = tab.openerTabId ?? gesture?.tabId;
  const createdAt = Date.now();
  const [contextTabId] = [...contextLinks].findLast(([, link]) =>
    link.windowId === tab.windowId && createdAt - link.openedAt <= CONTEXT_LINK_WINDOW_MS
  ) ?? [];
  if ((sourceTabId == null && contextTabId == null) || sourceTabId === tab.id) return;

  const candidate = {
    tabId: tab.id,
    windowId: tab.windowId,
    sourceTabId,
    contextTabId,
    destinationUrl: tab.pendingUrl || tab.url || "",
    initialUrl: tab.pendingUrl || tab.url || "",
    wasActive: tab.active,
    gesture,
    createdAt
  };

  candidates.set(tab.id, candidate);
  if (sourceTabId != null) {
    const sourceTab = await chrome.tabs.get(sourceTabId).catch(() => null);
    candidate.sourceUrl = sourceTab?.url;
  }
  setTimeout(() => void finalizeCandidate(tab.id), CANDIDATE_DELAY_MS);
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  const candidate = candidates.get(tabId);
  if (candidate) candidate.wasActive = true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const candidate = candidates.get(tabId);
  if (!candidate) return;

  if (changeInfo.url) candidate.destinationUrl = changeInfo.url;
});

chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId, url }) => {
  const candidate = candidates.get(tabId);
  if (candidate && frameId === 0 && !hostnameFromUrl(candidate.initialUrl)) {
    candidate.initialUrl = url;
  }
});

chrome.webNavigation.onCommitted.addListener(trackNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(trackNavigation);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(trackNavigation);

function queueNavigation(tabId, task) {
  const next = (navigationQueues.get(tabId) ?? Promise.resolve())
    .then(task)
    .catch((error) => console.error("Ad Tab Guard could not process navigation", error))
    .finally(() => {
      if (navigationQueues.get(tabId) === next) navigationQueues.delete(tabId);
    });
  navigationQueues.set(tabId, next);
}

function trackNavigation({
  tabId, frameId, documentLifecycle, url, transitionType, transitionQualifiers = []
}) {
  if (frameId !== 0 || documentLifecycle !== "active") return;

  const browserNavigation = transitionType === "auto_bookmark" ||
    transitionQualifiers.includes("from_address_bar") ||
    transitionQualifiers.includes("forward_back");

  queueNavigation(tabId, async () => {
    const key = `navigation:${tabId}`;
    if (!hostnameFromUrl(url)) {
      await chrome.storage.session.remove(key);
      return;
    }

    const { [key]: previous } = await chrome.storage.session.get(key);
    // A page that redirects on load gets one restoration until the user interacts again.
    const gestureAt = recentGestures.get(tabId)?.receivedAt ?? 0;
    if (previous && !browserNavigation && (!previous.restoredAt || gestureAt > previous.restoredAt)) {
      const settings = await getSettings();
      const decision = classifyCandidate({ sourceUrl: previous.url, destinationUrl: url, settings });

      if (decision.shouldClose) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab?.url !== url || tab.pendingUrl) return;

        await chrome.storage.session.set({ [key]: { url: previous.url, restoredAt: Date.now() } });
        await chrome.tabs.update(tabId, { url: previous.url });
        return;
      }
    }

    const restoredAt = !browserNavigation && previous?.url === url ? previous.restoredAt : 0;
    await chrome.storage.session.set({ [key]: { url, restoredAt } });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  candidates.delete(tabId);
  recentGestures.delete(tabId);
  contextLinks.delete(tabId);
  queueNavigation(tabId, () => chrome.storage.session.remove(`navigation:${tabId}`));
});

async function finalizeCandidate(tabId) {
  const candidate = candidates.get(tabId);
  if (!candidate) return;

  const spawnedTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!spawnedTab) {
    candidates.delete(tabId);
    return;
  }

  candidate.destinationUrl =
    spawnedTab.pendingUrl || spawnedTab.url || candidate.destinationUrl;

  const openerTabId = spawnedTab.openerTabId ?? candidate.sourceTabId;
  const sourceTabId = openerTabId ?? candidate.contextTabId;
  const sourceUrl = sourceTabId === candidate.sourceTabId ? candidate.sourceUrl :
    (await chrome.tabs.get(sourceTabId).catch(() => null))?.url;
  candidates.delete(tabId);

  // shortcut: Chrome exposes the clicked link and tab state, so correlate those until it exposes the native menu command.
  const contextLink = contextLinks.get(sourceTabId);
  const initialUrl = hostnameFromUrl(candidate.initialUrl) ? candidate.initialUrl : candidate.destinationUrl;
  const matchesContext = contextLink?.url === initialUrl && contextLink.sourceUrl === sourceUrl &&
      contextLink.windowId === candidate.windowId &&
      candidate.createdAt - contextLink.openedAt >= 0 &&
      candidate.createdAt - contextLink.openedAt <= CONTEXT_LINK_WINDOW_MS;
  if (matchesContext) {
    contextLinks.delete(sourceTabId);
    if (!candidate.wasActive && !spawnedTab.active && spawnedTab.windowId === candidate.windowId) return;
  } else if (openerTabId == null) {
    return;
  }

  const settings = await getSettings();
  const decision = classifyCandidate({
    sourceUrl,
    destinationUrl: candidate.destinationUrl,
    gesture: candidate.gesture,
    settings
  });

  if (!decision.shouldClose) return;

  try {
    if (spawnedTab.active) {
      await chrome.tabs.update(sourceTabId, { active: true });
    }
    await chrome.tabs.remove(tabId);
  } catch {
    return;
  }

  const shouldRetry = Boolean(
    settings.retryClicks &&
    candidate.gesture?.id &&
    !candidate.gesture.explicitNewTab &&
    !retriedGestures.has(candidate.gesture.id)
  );

  if (shouldRetry) {
    retriedGestures.add(candidate.gesture.id);
    setTimeout(() => retriedGestures.delete(candidate.gesture.id), 10_000);
  }

  await recordClosure({ ...candidate, sourceTabId, sourceUrl }, decision, settings, shouldRetry);
}

async function recordClosure(candidate, decision, settings, retryAttempted) {
  const destinationHost =
    decision.destinationHost || hostnameFromUrl(candidate.destinationUrl) || "unresolved destination";
  const sourceHost =
    decision.sourceHost || hostnameFromUrl(candidate.sourceUrl) || "protected site";

  const event = {
    id: `${Date.now()}-${candidate.tabId}`,
    closedAt: Date.now(),
    sourceHost,
    destinationHost,
    destinationUrl: candidate.destinationUrl,
    reason: decision.reason,
    retryAttempted
  };

  const closedCount = settings.closedCount + 1;
  const closedEvents = [event, ...settings.closedEvents].slice(0, MAX_LOG_ENTRIES);
  await chrome.storage.local.set({ closedCount, closedEvents });
  await updateBadge(closedCount);

  const message = retryAttempted
    ? `Closed ${destinationHost}. Retrying your click once…`
    : `Closed ${destinationHost}, opened by ${sourceHost}.`;

  try {
    await chrome.tabs.sendMessage(candidate.sourceTabId, {
      type: "show-closure-toast",
      message
    });
  } catch {
    // Some browser-controlled pages cannot receive content-script messages.
  }

  if (retryAttempted) {
    try {
      await chrome.tabs.sendMessage(candidate.sourceTabId, {
        type: "retry-gesture",
        gestureId: candidate.gesture.id
      });
    } catch {
      // The source page may have navigated or removed the clicked element.
    }
  }

  try {
    await chrome.notifications.create(event.id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/shield-128.png"),
      title: "Ad Tab Guard closed a tab",
      message,
      priority: 1
    });
  } catch {
    // The in-page toast and popup history still report the closure.
  }
}
