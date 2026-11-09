import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyCandidate,
  domainMatches,
  hostnameFromUrl,
  isSameSite
} from "../lib/rules.js";

const settings = {
  enabled: true,
  protectAll: false,
  retryClicks: true,
  allowIntentionalNewTabs: false,
  protectedSites: ["video.example"],
  allowedDomains: ["accounts.example.org"]
};

test("extracts HTTP hostnames and rejects browser pages", () => {
  assert.equal(hostnameFromUrl("https://News.Example/path"), "news.example");
  assert.equal(hostnameFromUrl("chrome://extensions"), "");
});

test("matches configured domains and their subdomains", () => {
  assert.equal(domainMatches("www.video.example", "video.example"), true);
  assert.equal(domainMatches("notvideo.example", "video.example"), false);
});

test("recognizes same-site subdomains", () => {
  assert.equal(isSameSite("video.example", "cdn.video.example"), true);
  assert.equal(isSameSite("video.example", "ads.example"), false);
});

test("closes an unexpected cross-site tab from a protected source", () => {
  const result = classifyCandidate({
    sourceUrl: "https://video.example/watch/1",
    destinationUrl: "https://popunder.invalid/ad",
    gesture: { explicitNewTab: false },
    settings
  });

  assert.equal(result.shouldClose, true);
  assert.equal(result.reason, "unexpected-cross-site-tab");
});

test("closes a modifier-assisted cross-site tab in aggressive mode", () => {
  const result = classifyCandidate({
    sourceUrl: "https://video.example/watch/1",
    destinationUrl: "https://docs.example.net",
    gesture: { explicitNewTab: true },
    settings
  });

  assert.equal(result.shouldClose, true);
  assert.equal(result.reason, "unexpected-cross-site-tab");
});

test("can allow modifier-assisted new tabs when configured", () => {
  const result = classifyCandidate({
    sourceUrl: "https://video.example/watch/1",
    destinationUrl: "https://docs.example.net",
    gesture: { explicitNewTab: true },
    settings: { ...settings, allowIntentionalNewTabs: true }
  });

  assert.equal(result.shouldClose, false);
  assert.equal(result.reason, "intentional-new-tab");
});

test("allows same-site and allowlisted destinations", () => {
  const sameSite = classifyCandidate({
    sourceUrl: "https://video.example/watch/1",
    destinationUrl: "https://help.video.example/article",
    gesture: { explicitNewTab: false },
    settings
  });
  const allowlisted = classifyCandidate({
    sourceUrl: "https://video.example/watch/1",
    destinationUrl: "https://accounts.example.org/login",
    gesture: { explicitNewTab: false },
    settings
  });

  assert.equal(sameSite.shouldClose, false);
  assert.equal(allowlisted.shouldClose, false);
});

test("does nothing when the source is not protected", () => {
  const result = classifyCandidate({
    sourceUrl: "https://safe.example",
    destinationUrl: "https://another.example",
    gesture: { explicitNewTab: false },
    settings
  });

  assert.equal(result.shouldClose, false);
  assert.equal(result.reason, "source-not-protected");
});
