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

let settings;
let currentHostname = "";

const enabledInput = document.getElementById("enabled");
const protectAllInput = document.getElementById("protect-all");
const retryClicksInput = document.getElementById("retry-clicks");
const allowIntentionalTabsInput = document.getElementById("allow-intentional-tabs");
const toggleSiteButton = document.getElementById("toggle-site");
const siteElement = document.getElementById("site");
const siteStatusElement = document.getElementById("site-status");
const historyElement = document.getElementById("history");
const countElement = document.getElementById("count");

void initialize();

async function initialize() {
  settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  currentHostname = hostnameFromUrl(tab?.url);
  render();
}

function hostnameFromUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

function isProtected(hostname) {
  return settings.protectedSites.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
}

function render() {
  enabledInput.checked = settings.enabled;
  protectAllInput.checked = settings.protectAll;
  retryClicksInput.checked = settings.retryClicks;
  allowIntentionalTabsInput.checked = settings.allowIntentionalNewTabs;
  countElement.textContent = settings.closedCount;

  if (!currentHostname) {
    siteElement.textContent = "This page cannot be protected";
    siteStatusElement.textContent = "Open a normal website first.";
    toggleSiteButton.disabled = true;
  } else {
    const protectedHere = isProtected(currentHostname);
    siteElement.textContent = currentHostname;
    siteStatusElement.textContent = settings.protectAll
      ? "Protected by the every-website setting."
      : protectedHere
        ? settings.retryClicks
          ? "Blocks cross-site tabs, retries their clicks once, and reverses cross-site navigation."
          : "Blocks cross-site tabs and reverses cross-site navigation."
        : "Protection is off for this site.";
    toggleSiteButton.textContent = protectedHere ? "Stop protecting this site" : "Protect this site";
    toggleSiteButton.className = protectedHere ? "secondary" : "";
    toggleSiteButton.disabled = false;
  }

  renderHistory();
}

function renderHistory() {
  historyElement.replaceChildren();

  if (!settings.closedEvents.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nothing closed yet.";
    historyElement.append(empty);
    return;
  }

  for (const event of settings.closedEvents.slice(0, 20)) {
    const row = document.createElement("div");
    row.className = "event";

    const main = document.createElement("div");
    main.className = "event-main";
    main.textContent = `${event.sourceHost} → ${event.destinationHost}`;

    const meta = document.createElement("div");
    meta.className = "event-meta";

    const time = document.createElement("span");
    const formattedTime = new Date(event.closedAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    });
    time.textContent = event.retryAttempted ? `Retried · ${formattedTime}` : formattedTime;
    meta.append(time);

    if (event.destinationHost && event.destinationHost !== "unresolved destination") {
      const allowButton = document.createElement("button");
      allowButton.type = "button";
      allowButton.className = "small secondary";
      allowButton.textContent = settings.allowedDomains.includes(event.destinationHost)
        ? "Allowed"
        : "Always allow";
      allowButton.disabled = settings.allowedDomains.includes(event.destinationHost);
      allowButton.addEventListener("click", () => void allowDomain(event.destinationHost));
      meta.append(allowButton);
    }

    row.append(main, meta);
    historyElement.append(row);
  }
}

enabledInput.addEventListener("change", async () => {
  settings.enabled = enabledInput.checked;
  await chrome.storage.local.set({ enabled: settings.enabled });
  render();
});

protectAllInput.addEventListener("change", async () => {
  settings.protectAll = protectAllInput.checked;
  await chrome.storage.local.set({ protectAll: settings.protectAll });
  render();
});

retryClicksInput.addEventListener("change", async () => {
  settings.retryClicks = retryClicksInput.checked;
  await chrome.storage.local.set({ retryClicks: settings.retryClicks });
  render();
});

allowIntentionalTabsInput.addEventListener("change", async () => {
  settings.allowIntentionalNewTabs = allowIntentionalTabsInput.checked;
  await chrome.storage.local.set({
    allowIntentionalNewTabs: settings.allowIntentionalNewTabs
  });
  render();
});

toggleSiteButton.addEventListener("click", async () => {
  if (!currentHostname) return;

  if (isProtected(currentHostname)) {
    settings.protectedSites = settings.protectedSites.filter(
      (domain) => domain !== currentHostname
    );
  } else {
    settings.protectedSites = [...settings.protectedSites, currentHostname];
  }

  await chrome.storage.local.set({ protectedSites: settings.protectedSites });
  render();
});

document.getElementById("clear-history").addEventListener("click", async () => {
  settings.closedCount = 0;
  settings.closedEvents = [];
  await chrome.storage.local.set({ closedCount: 0, closedEvents: [] });
  await chrome.action.setBadgeText({ text: "" });
  render();
});

async function allowDomain(domain) {
  if (!settings.allowedDomains.includes(domain)) {
    settings.allowedDomains = [...settings.allowedDomains, domain];
    await chrome.storage.local.set({ allowedDomains: settings.allowedDomains });
  }
  render();
}
