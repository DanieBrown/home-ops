function chromeCall(method, ...args) {
  return new Promise((resolve, reject) => {
    method(...args, (value) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(value);
    });
  });
}

async function getCurrentTab() {
  return chromeCall(chrome.tabs.getCurrent);
}

async function queryTabs(queryInfo) {
  return chromeCall(chrome.tabs.query, queryInfo);
}

async function createTab(createProperties) {
  return chromeCall(chrome.tabs.create, createProperties);
}

async function removeTabs(tabIds) {
  if (!Array.isArray(tabIds) || tabIds.length === 0) {
    return;
  }

  return chromeCall(chrome.tabs.remove, tabIds);
}

async function groupTabs(options) {
  return chromeCall(chrome.tabs.group, options);
}

async function updateTabGroup(groupId, updateProperties) {
  return chromeCall(chrome.tabGroups.update, groupId, updateProperties);
}

function normalizeUrls(urls) {
  const seen = new Set();
  const normalized = [];

  for (const rawUrl of urls ?? []) {
    const url = String(rawUrl ?? '').trim();
    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    normalized.push(url);
  }

  return normalized;
}

async function openReviewTabs({ urls, groupTitle = null, groupColor = 'blue', replaceExisting = false }) {
  const normalizedUrls = normalizeUrls(urls);
  const currentTab = await getCurrentTab();

  if (!currentTab?.windowId) {
    throw new Error('Could not resolve the current Chrome window for review tab management.');
  }

  const existingWindowTabs = await queryTabs({ windowId: currentTab.windowId });

  if (replaceExisting) {
    const removableTabIds = (await queryTabs({}))
      .map((tab) => tab.id)
      .filter((tabId) => Number.isInteger(tabId) && tabId !== currentTab.id);

    await removeTabs(removableTabIds);
  }

  const createdTabs = [];
  let nextIndex = Number.isInteger(currentTab.index) ? currentTab.index + 1 : undefined;

  if (!Number.isInteger(nextIndex)) {
    nextIndex = existingWindowTabs.length;
  }

  for (let index = 0; index < normalizedUrls.length; index += 1) {
    const createdTab = await createTab({
      windowId: currentTab.windowId,
      url: normalizedUrls[index],
      active: index === 0,
      index: nextIndex,
    });

    createdTabs.push(createdTab);
    if (Number.isInteger(nextIndex)) {
      nextIndex += 1;
    }
  }

  let groupId = null;
  const tabIds = createdTabs.map((tab) => tab.id).filter((tabId) => Number.isInteger(tabId));

  if (groupTitle && tabIds.length > 0) {
    groupId = await groupTabs({ tabIds });
    await updateTabGroup(groupId, {
      title: groupTitle,
      color: groupColor,
      collapsed: false,
    });
  }

  return {
    windowId: currentTab.windowId,
    groupId,
    tabIds,
    urls: createdTabs.map((tab) => tab.pendingUrl || tab.url).filter(Boolean),
  };
}

window.homeOpsReviewTabs = {
  openReviewTabs,
};