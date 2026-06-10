/**
 * detection-store.js
 * ES6 module — persists per-tab detection state in chrome.storage.session.
 *
 * State shape per tab:
 * {
 *   status:       'idle' | 'scanning' | 'done' | 'error',
 *   url:          string,
 *   results:      DetectionResult[],
 *   aiCount:      number,   // results with P(AI) confidence >= the user threshold
 *   totalScanned: number,   // results where label !== 'skip' && label !== 'insufficient'
 * }
 */

/**
 * Returns the chrome.storage.session key for a given tab ID.
 *
 * @param {number} tabId
 * @returns {string}
 */
function tabKey(tabId) {
  return `detectai_tab_${tabId}`;
}

/**
 * Persist the full state object for a tab.
 *
 * @param {number} tabId
 * @param {{ status: string, url: string, results: DetectionResult[], aiCount: number, totalScanned: number }} state
 * @returns {Promise<void>}
 */
export async function saveTabState(tabId, state) {
  await chrome.storage.session.set({ [tabKey(tabId)]: state });
}

/**
 * Retrieve the state object for a tab.
 *
 * @param {number} tabId
 * @returns {Promise<{ status: string, url: string, results: DetectionResult[], aiCount: number, totalScanned: number } | null>}
 */
export async function getTabState(tabId) {
  const key = tabKey(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

/**
 * Remove all stored state for a tab.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function clearTabState(tabId) {
  await chrome.storage.session.remove(tabKey(tabId));
}

/**
 * Update only the status field of the tab's stored state.
 * If no state exists yet, creates a minimal record.
 *
 * @param {number} tabId
 * @param {'idle' | 'scanning' | 'done' | 'error'} status
 * @returns {Promise<void>}
 */
export async function updateStatus(tabId, status, url) {
  const existing = await getTabState(tabId);

  const updated = existing
    ? { ...existing, status, ...(url != null ? { url } : {}) }
    : {
        status,
        url: url || '',
        results: [],
        aiCount: 0,
        totalScanned: 0,
      };

  await saveTabState(tabId, updated);
}
