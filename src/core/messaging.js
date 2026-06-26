// Thin wrappers over chrome.runtime messaging with target-based routing.
// Every message carries a `target` (see TARGET in shared/constants.js); each
// context ignores messages not addressed to it.

export async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    // No receiver (e.g. side panel closed, offscreen not yet created) is fine.
    return undefined;
  }
}

// Register a handler for messages addressed to `target`. The handler may return
// a value or a Promise; the resolved value is sent back as the response.
export function listen(target, handler) {
  const listener = (message, sender, sendResponse) => {
    if (!message || (message.target && message.target !== target)) return false;
    let result;
    try {
      result = handler(message, sender);
    } catch (err) {
      sendResponse({ error: String(err && err.message || err) });
      return false;
    }
    if (result && typeof result.then === 'function') {
      result.then(
        (r) => sendResponse(r),
        (err) => sendResponse({ error: String(err && err.message || err) }),
      );
      return true; // keep the channel open for the async response
    }
    if (result !== undefined) sendResponse(result);
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
