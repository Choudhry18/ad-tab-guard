let toastTimer;
let activePointerGesture;
const retryTargets = new Map();
const retriedGestures = new Set();

function findAnchor(target) {
  return target instanceof Element ? target.closest("a[href]") : null;
}

function createGestureId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function rememberRetryTarget(id, event) {
  const target = event.composedPath?.()[0] || event.target;
  retryTargets.set(id, {
    target: target instanceof Element ? target : null,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY
  });

  setTimeout(() => retryTargets.delete(id), 10_000);
}

function sendGesture(event, id) {
  const anchor = findAnchor(event.target);
  const explicitNewTab =
    event.button === 1 || event.metaKey || event.ctrlKey || event.shiftKey;

  chrome.runtime.sendMessage({
    type: "gesture",
    gesture: {
      id,
      occurredAt: Date.now(),
      explicitNewTab,
      targetBlank: anchor?.target === "_blank"
    }
  }).catch(() => {});
}

document.addEventListener("pointerdown", (event) => {
  if (!event.isTrusted || event.button > 1) return;

  const id = createGestureId();
  activePointerGesture = { id, occurredAt: Date.now() };
  rememberRetryTarget(id, event);
  sendGesture(event, id);
}, true);

document.addEventListener("click", (event) => {
  if (!event.isTrusted) return;

  const canReusePointer =
    activePointerGesture && Date.now() - activePointerGesture.occurredAt < 2_000;
  const id = canReusePointer ? activePointerGesture.id : createGestureId();
  activePointerGesture = undefined;
  rememberRetryTarget(id, event);
  sendGesture(event, id);
}, true);

document.addEventListener("contextmenu", (event) => {
  if (!event.isTrusted) return;

  const anchor = findAnchor(event.composedPath()[0]);
  chrome.runtime.sendMessage({ type: "context-link", url: anchor?.href }).catch(() => {});
}, true);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "show-closure-toast") {
    showToast(message.message);
  }

  if (message?.type === "retry-gesture") {
    retryGesture(message.gestureId);
  }
});

function retryGesture(gestureId) {
  if (!gestureId || retriedGestures.has(gestureId)) return;

  const remembered = retryTargets.get(gestureId);
  if (!remembered) return;

  retriedGestures.add(gestureId);
  setTimeout(() => retriedGestures.delete(gestureId), 10_000);

  setTimeout(() => {
    const target = remembered.target?.isConnected
      ? remembered.target
      : document.elementFromPoint(remembered.clientX, remembered.clientY);
    if (!(target instanceof Element)) return;

    const baseOptions = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      clientX: remembered.clientX,
      clientY: remembered.clientY,
      screenX: remembered.screenX,
      screenY: remembered.screenY
    };

    if (typeof PointerEvent === "function") {
      target.dispatchEvent(new PointerEvent("pointerdown", { ...baseOptions, buttons: 1 }));
    }
    target.dispatchEvent(new MouseEvent("mousedown", { ...baseOptions, buttons: 1 }));
    if (typeof PointerEvent === "function") {
      target.dispatchEvent(new PointerEvent("pointerup", { ...baseOptions, buttons: 0 }));
    }
    target.dispatchEvent(new MouseEvent("mouseup", { ...baseOptions, buttons: 0 }));
    target.dispatchEvent(new MouseEvent("click", { ...baseOptions, buttons: 0 }));
  }, 120);
}

function showToast(message) {
  let host = document.getElementById("ad-tab-guard-toast-host");

  if (!host) {
    host = document.createElement("div");
    host.id = "ad-tab-guard-toast-host";
    host.style.cssText = [
      "all: initial",
      "position: fixed",
      "top: 18px",
      "right: 18px",
      "z-index: 2147483647"
    ].join(";");
    document.documentElement.append(host);
    host.attachShadow({ mode: "open" });
  }

  host.shadowRoot.innerHTML = `
    <style>
      .toast {
        box-sizing: border-box;
        max-width: 390px;
        padding: 13px 15px;
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 12px;
        background: #111827;
        box-shadow: 0 14px 36px rgba(0,0,0,.32);
        color: #f9fafb;
        font: 600 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .label { color: #86efac; margin-right: 6px; }
    </style>
    <div class="toast" role="status" aria-live="polite">
      <span class="label">Blocked</span><span class="message"></span>
    </div>
  `;
  host.shadowRoot.querySelector(".message").textContent = message;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.remove(), 5000);
}
