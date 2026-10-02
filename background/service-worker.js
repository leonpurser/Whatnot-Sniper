// Background service worker. Kept deliberately thin: all auction logic lives in
// the content script (it must run in the Whatnot tab), and the UI lives in the
// side panel. This only opens the side panel and maintains the badge.
'use strict';

function enablePanelOnClick() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.error('[WBA] sidePanel', e));
}
chrome.runtime.onInstalled.addListener(enablePanelOnClick);
chrome.runtime.onStartup.addListener(enablePanelOnClick);

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'badge' || !sender.tab) return;
  const tabId = sender.tab.id;
  chrome.action.setBadgeText({ tabId, text: msg.text || '' });
  if (msg.color) chrome.action.setBadgeBackgroundColor({ tabId, color: msg.color });
});
