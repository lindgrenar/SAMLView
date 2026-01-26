const MAX_MESSAGES = 1000;
const MIN_BASE64_LENGTH = 16;
const XML_DETECTION_PREVIEW_LENGTH = 400;
const LOG_PREFIX = '[SAMLView]';

// Per-window sessions: Map<windowId, SessionState>
const sessions = new Map();
let tabListeners = null; // Shared tab listeners for all sessions
let pendingTargetTab = null; // Target tab for next window

// SessionState structure:
// {
//   windowId: number,
//   rootTabId: number,
//   trackedTabIds: Set<number>,
//   messages: Array,
//   nextMessageId: number,
//   seenKeys: Set<string>,
//   requestIdToMessageId: Map<string, number>
// }

function createSession(windowId, rootTabId) {
  return {
    windowId,
    rootTabId,
    trackedTabIds: new Set([rootTabId]),
    messages: [],
    nextMessageId: 1,
    seenKeys: new Set(),
    requestIdToMessageId: new Map()
  };
}

function getSessionByWindowId(windowId) {
  return sessions.get(windowId);
}

function getSessionByTabId(tabId) {
  for (const session of sessions.values()) {
    if (session.trackedTabIds.has(tabId)) {
      return session;
    }
  }
  return null;
}

function onTabCreated(tab) {
  if (sessions.size === 0) return;
  // Firefox provides openerTabId for tabs opened by another tab
  if (tab.openerTabId) {
    const session = getSessionByTabId(tab.openerTabId);
    if (session) {
      session.trackedTabIds.add(tab.id);
      console.log(`${LOG_PREFIX} [Window ${session.windowId}] Tracking new tab ${tab.id} (opened by ${tab.openerTabId})`);
    }
  }
}

function onTabRemoved(tabId) {
  const session = getSessionByTabId(tabId);
  if (session) {
    session.trackedTabIds.delete(tabId);
    console.log(`${LOG_PREFIX} [Window ${session.windowId}] Stopped tracking tab ${tabId}`);
  }
}

async function startCapture(windowId, rootTabId) {
  const session = createSession(windowId, rootTabId);
  session.isCapturing = true; // Mark session as actively capturing
  sessions.set(windowId, session);

  // Add shared listeners only once
  if (!tabListeners) {
    tabListeners = { created: onTabCreated, removed: onTabRemoved };
    browser.tabs.onCreated.addListener(tabListeners.created);
    browser.tabs.onRemoved.addListener(tabListeners.removed);
    console.log(`${LOG_PREFIX} Tab listeners registered`);
  }

  console.log(`${LOG_PREFIX} [Window ${windowId}] Started capture on tab ${rootTabId}`);
}

function stopCapture(windowId) {
  sessions.delete(windowId);

  // Remove listeners if no sessions remain
  if (sessions.size === 0 && tabListeners) {
    browser.tabs.onCreated.removeListener(tabListeners.created);
    browser.tabs.onRemoved.removeListener(tabListeners.removed);
    tabListeners = null;
    console.log(`${LOG_PREFIX} Tab listeners removed (no active sessions)`);
  }

  console.log(`${LOG_PREFIX} [Window ${windowId}] Stopped capture`);
}

function b64ToBytes(b64) {
  try {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch (e) {
    console.error(`${LOG_PREFIX} Base64 decode failed:`, e);
    return null;
  }
}

function looksLikeBase64(s) {
  if (!s || s.length < MIN_BASE64_LENGTH) return false;
  // quick heuristic: only base64 chars and length multiple of 4
  if (!/^[A-Za-z0-9+/=]+$/.test(s)) return false;
  return (s.length % 4) === 0;
}

function looksLikeXML(text) {
  if (!text) return false;
  const t = text.trim().slice(0, 200);
  return t.startsWith('<') || t.startsWith('<?xml');
}

async function maybeInflateDeflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    console.warn(`${LOG_PREFIX} DecompressionStream not available, cannot inflate deflate-raw data`);
    return bytes;
  }
  try {
    const stream = new DecompressionStream('deflate-raw');
    const ds = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    const inflated = new Uint8Array(await ds.arrayBuffer());
    return inflated;
  } catch (e) {
    console.warn(`${LOG_PREFIX} Deflate inflation failed:`, e);
    return bytes; // fallback if inflate fails
  }
}

function bytesToUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch (e) {
    console.error(`${LOG_PREFIX} UTF-8 decode failed:`, e);
    return null;
  }
}

async function decodeSAML(b64, tryInflate) {
  const raw = b64ToBytes(b64);
  if (!raw) return null;
  let data = raw;
  if (tryInflate) {
    data = await maybeInflateDeflateRaw(raw);
  }
  const text = bytesToUtf8(data);
  return text || null;
}

function decodeRawBody(details) {
  try {
    const rb = details.requestBody && details.requestBody.raw;
    if (!rb || !rb.length) return null;
    // concatenate parts if multiple
    const parts = rb.map(p => p.bytes ? new Uint8Array(p.bytes) : new Uint8Array()).filter(b => b.length);
    if (!parts.length) return null;
    let totalLen = 0; for (const p of parts) totalLen += p.length;
    const buf = new Uint8Array(totalLen);
    let offset = 0; for (const p of parts) { buf.set(p, offset); offset += p.length; }
    const text = bytesToUtf8(buf);
    return text || null;
  } catch (error) {
    console.error(`${LOG_PREFIX} Raw body decode failed:`, error);
    return null;
  }
}

function extractSAMLFromJSONText(text) {
  try {
    const obj = JSON.parse(text);
    let found = [];
    const walk = (v, k) => {
      if (typeof v === 'string') {
        const key = (k || '').toLowerCase();
        if (key.includes('samlresponse') || key.includes('samlrequest')) {
          found.push({ name: k, value: v });
        } else if (looksLikeBase64(v)) {
          found.push({ name: k || 'b64', value: v });
        }
      } else if (v && typeof v === 'object') {
        for (const [ck, cv] of Object.entries(v)) walk(cv, ck);
      }
    };
    walk(obj, '');
    return found.length ? found : null;
  } catch (_) {
    return null;
  }
}

function makeArtifactXML(artifact) {
  const safe = artifact.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return `<!-- SAMLArtifact: ${safe} (Note: Full assertion not available via Artifact binding) -->`;
}

function extractFromQuery(url) {
  try {
    const u = new URL(url);
    const q = u.searchParams;
    if (q.has('SAMLResponse')) return { name: 'SAMLResponse', value: q.get('SAMLResponse'), transport: 'GET' };
    if (q.has('SAMLRequest')) return { name: 'SAMLRequest', value: q.get('SAMLRequest'), transport: 'GET' };
    if (q.has('SAMLart')) return { name: 'SAMLArtifact', value: q.get('SAMLart'), transport: 'GET' };
  } catch (error) {
    console.error(`${LOG_PREFIX} URL parse failed:`, error);
  }
  return null;
}

function extractFromBody(details) {
  const fd = details.requestBody && details.requestBody.formData;
  if (fd) {
    if (fd.SAMLResponse && fd.SAMLResponse[0]) return { name: 'SAMLResponse', value: fd.SAMLResponse[0], transport: 'POST' };
    if (fd.SAMLRequest && fd.SAMLRequest[0]) return { name: 'SAMLRequest', value: fd.SAMLRequest[0], transport: 'POST' };
    if (fd.SAMLart && fd.SAMLart[0]) return { name: 'SAMLArtifact', value: fd.SAMLart[0], transport: 'POST' };
  }
  // Try raw body: JSON or SOAP/XML
  const rawText = decodeRawBody(details);
  if (rawText) {
    // JSON path
    const foundJSON = extractSAMLFromJSONText(rawText);
    if (foundJSON) {
      for (const item of foundJSON) {
        const { name, value } = item;
        if (looksLikeBase64(value)) {
          return { name: (name && name.toLowerCase().includes('request')) ? 'SAMLRequest' : (name && name.toLowerCase().includes('response')) ? 'SAMLResponse' : 'SAMLBase64', value, transport: 'JSON' };
        }
      }
    }
    // SOAP/XML path: if it already looks like XML and contains saml
    if (looksLikeXML(rawText) && /samlp?:/i.test(rawText)) {
      return { name: 'SAML-XML', value: rawText, transport: 'SOAP' };
    }
  }
  return null;
}

async function handlePossibleSAML(details) {
  // Find session for this tab
  const session = getSessionByTabId(details.tabId);
  if (!session) return;

  try {
    let found = extractFromQuery(details.url) || extractFromBody(details);
    if (!found) return;

    // Extract RelayState if present
    let relayState = null;
    try {
      const urlObj = new URL(details.url);
      relayState = urlObj.searchParams.get('RelayState');
    } catch (e) { }

    if (!relayState && details.requestBody && details.requestBody.formData) {
      relayState = details.requestBody.formData.RelayState ? details.requestBody.formData.RelayState[0] : null;
    }

    // Extract relevant request headers
    const requestHeaders = {};
    if (details.requestHeaders) {
      for (const h of details.requestHeaders) {
        const name = (h.name || '').toLowerCase();
        if (['content-type', 'accept', 'authorization', 'user-agent'].includes(name)) {
          requestHeaders[h.name] = h.value;
        }
      }
    }

    // Artifact handling (no XML available on front channel)
    if (found.name === 'SAMLArtifact') {
      const artifactXml = makeArtifactXML(found.value);
      const entryA = {
        id: session.nextMessageId++,
        kind: 'SAMLArtifact',
        transport: found.transport,
        url: details.url,
        time: new Date().toISOString(),
        xml: artifactXml,
        tabId: details.tabId,
        source: 'artifact',
        base64: found.value,
        encoding: 'artifact',
        relayState,
        method: details.method,
        requestHeaders,
        requestId: details.requestId
      };
      addMessage(session, entryA);
      return;
    }

    // JSON-provided base64 payload without deflate
    if (found.transport === 'JSON') {
      const xmlJson = await decodeSAML(found.value, false);
      if (!xmlJson) return;
      const trimmedJ = (xmlJson || '').trim();
      if (!looksLikeXML(trimmedJ)) return;
      const entryJ = {
        id: session.nextMessageId++,
        kind: (found.name === 'SAMLRequest' || found.name === 'SAMLResponse') ? found.name : 'SAML',
        transport: 'JSON',
        url: details.url,
        time: new Date().toISOString(),
        xml: trimmedJ,
        tabId: details.tabId,
        source: 'json-body',
        base64: found.value,
        encoding: 'base64',
        relayState,
        method: details.method,
        requestHeaders,
        requestId: details.requestId
      };
      addMessage(session, entryJ);
      return;
    }

    // SOAP/XML: already XML in body
    if (found.transport === 'SOAP' && looksLikeXML(found.value)) {
      const trimmedS = found.value.trim();
      const entryS = {
        id: session.nextMessageId++,
        kind: 'SAML-XML',
        transport: 'SOAP',
        url: details.url,
        time: new Date().toISOString(),
        xml: trimmedS,
        tabId: details.tabId,
        source: 'soap-xml',
        base64: null,
        encoding: 'none',
        relayState,
        method: details.method,
        requestHeaders,
        requestId: details.requestId
      };
      addMessage(session, entryS);
      return;
    }

    // Default: GET/POST bindings with possible deflate for SAMLRequest
    const tryInflate = found.name === 'SAMLRequest';
    const xml = await decodeSAML(found.value, tryInflate);
    if (!xml || typeof xml !== 'string' || xml.trim().length === 0) return;

    const trimmed = xml.trim();
    if (!looksLikeXML(trimmed)) return;

    const entry = {
      id: session.nextMessageId++,
      kind: found.name, // SAMLRequest or SAMLResponse
      transport: found.transport, // GET or POST
      url: details.url,
      time: new Date().toISOString(),
      xml: trimmed,
      tabId: details.tabId,
      base64: found.value,
      encoding: tryInflate ? 'deflate-raw' : 'base64',
      relayState,
      method: details.method,
      requestHeaders,
      requestId: details.requestId
    };
    addMessage(session, entry);
  } catch (error) {
    console.error(`${LOG_PREFIX} [Window ${session.windowId}] Error processing SAML:`, error, 'URL:', details.url);
  }
}

function notifyUpdate(windowId) {
  const session = sessions.get(windowId);
  if (session) {
    try {
      browser.runtime.sendMessage({
        type: 'messagesUpdated',
        windowId,
        count: session.messages.length
      }).catch(() => { });
    } catch (error) {
      console.error(`${LOG_PREFIX} [Window ${windowId}] Failed to notify update:`, error);
    }
  }
}

function makeDedupKey(kind, xml) {
  return `${kind}|${xml}`;
}

function addMessage(session, entry) {
  const key = makeDedupKey(entry.kind, entry.xml);
  if (session.seenKeys.has(key)) {
    console.log(`${LOG_PREFIX} [Window ${session.windowId}] Duplicate message ignored (id: ${entry.id})`);
    return false;
  }

  session.seenKeys.add(key);
  session.messages.push(entry);

  // Register requestId mapping for response correlation
  if (entry.requestId) {
    session.requestIdToMessageId.set(entry.requestId, entry.id);
  }

  // Enforce size limit (LRU eviction)
  if (session.messages.length > MAX_MESSAGES) {
    const removed = session.messages.shift();
    session.seenKeys.delete(makeDedupKey(removed.kind, removed.xml));
    if (removed.requestId) {
      session.requestIdToMessageId.delete(removed.requestId);
    }
    console.warn(`${LOG_PREFIX} [Window ${session.windowId}] Message limit reached (${MAX_MESSAGES}), removed oldest message (id: ${removed.id})`);
  }

  console.log(`${LOG_PREFIX} [Window ${session.windowId}] Added message ${entry.id}: ${entry.kind} via ${entry.transport}`);
  notifyUpdate(session.windowId);
  return true;
}

// Web request listeners with error handling
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      handlePossibleSAML(details);
    } catch (error) {
      console.error(`${LOG_PREFIX} onBeforeRequest error:`, error, 'URL:', details.url);
    }
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

// Inspect request headers for SAML
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      tryHandleHeaderSAML(details, true);
    } catch (error) {
      console.error(`${LOG_PREFIX} onBeforeSendHeaders error:`, error);
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

// Inspect response headers for SAML
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    try {
      tryHandleHeaderSAML(details, false);
    } catch (error) {
      console.error(`${LOG_PREFIX} onHeadersReceived error:`, error);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Capture response status and headers for correlation
browser.webRequest.onCompleted.addListener(
  (details) => {
    try {
      attachResponseData(details);
    } catch (error) {
      console.error(`${LOG_PREFIX} onCompleted error:`, error);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

function attachResponseData(details) {
  const session = getSessionByTabId(details.tabId);
  if (!session) return;

  // Find message by requestId
  const messageId = session.requestIdToMessageId.get(details.requestId);
  if (!messageId) return;

  const message = session.messages.find(m => m.id === messageId);
  if (!message) return;

  // Extract relevant response headers
  const responseHeaders = {};
  if (details.responseHeaders) {
    for (const h of details.responseHeaders) {
      const name = (h.name || '').toLowerCase();
      if (['content-type', 'location', 'set-cookie'].includes(name)) {
        responseHeaders[h.name] = h.value;
      }
    }
  }

  // Attach to message
  message.statusCode = details.statusCode;
  message.responseHeaders = responseHeaders;

  console.log(`${LOG_PREFIX} [Window ${session.windowId}] Attached response data to message ${messageId}: status ${details.statusCode}`);
  notifyUpdate(session.windowId);
}

function tryHandleHeaderSAML(details, isRequest) {
  // Find session for this tab
  const session = getSessionByTabId(details.tabId);
  if (!session) return;

  const hdrs = isRequest ? details.requestHeaders : details.responseHeaders;
  if (!hdrs) return;

  for (const h of hdrs) {
    const name = h.name || '';
    const value = String(h.value || '');
    if (!value) continue;
    // direct header names
    if (/^saml(response|request)$/i.test(name)) {
      handleHeaderValue(session, details, name, value, isRequest);
      continue;
    }
    // heuristic: base64 decodes to XML
    if (looksLikeBase64(value)) {
      handleHeaderValue(session, details, name, value, isRequest);
    }
  }
}

async function handleHeaderValue(session, details, headerName, b64Value, isRequest) {
  try {
    let kind = /response/i.test(headerName) ? 'SAMLResponse' : (/request/i.test(headerName) ? 'SAMLRequest' : 'SAML');
    let xml = await decodeSAML(b64Value, kind === 'SAMLRequest');
    if (!xml || !looksLikeXML(xml)) return;
    const entry = {
      id: session.nextMessageId++,
      kind,
      transport: isRequest ? 'HEADER(req)' : 'HEADER(res)',
      url: details.url,
      time: new Date().toISOString(),
      xml: xml.trim(),
      tabId: details.tabId,
      source: 'header'
    };
    addMessage(session, entry);
  } catch (error) {
    console.error(`${LOG_PREFIX} [Window ${session.windowId}] Header SAML processing error:`, error);
  }
}

function guessKindFromXML(xml) {
  const t = xml.slice(0, XML_DETECTION_PREVIEW_LENGTH);
  if (/\bAuthnRequest\b/i.test(t)) return 'SAMLRequest';
  if (/\bResponse\b/i.test(t)) return 'SAMLResponse';
  return 'SAML-XML';
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;

  // Get windowId from sender or message
  const windowId = sender.tab ? sender.tab.windowId : msg.windowId;

  try {
    switch (msg.type) {
      case 'getState': {
        const session = getSessionByWindowId(windowId);
        return Promise.resolve({
          capturing: session ? !!session.isCapturing : false,
          rootTabId: session ? session.rootTabId : null,
          trackedCount: session ? session.trackedTabIds.size : 0,
          messageCount: session ? session.messages.length : 0,
        });
      }
      case 'getTargetTab': {
        // Return the pending target tab (don't clear it - let it be overwritten on next open)
        return Promise.resolve({ targetTabId: pendingTargetTab });
      }
      case 'startCapture': {
        if (!getSessionByWindowId(windowId)) {
          startCapture(windowId, msg.tabId);
        }
        return Promise.resolve({ capturing: true });
      }
      case 'stopCapture':
        stopCapture(windowId);
        return Promise.resolve({ capturing: false });
      case 'getMessages': {
        const session = getSessionByWindowId(windowId);
        return Promise.resolve({ messages: session ? session.messages : [] });
      }
      case 'clearMessages': {
        const session = getSessionByWindowId(windowId);
        if (session) {
          session.messages = [];
          session.seenKeys.clear();
          console.log(`${LOG_PREFIX} [Window ${windowId}] Messages cleared`);
          notifyUpdate(windowId);
        }
        return Promise.resolve({ ok: true });
      }
      case 'importMessages': {
        let session = getSessionByWindowId(windowId);

        // If no session exists, create a new one just to hold imported messages
        if (!session) {
          console.log(`${LOG_PREFIX} [Window ${windowId}] No session found for import, creating new session.`);
          session = createSession(windowId, -1); // Use -1 as a placeholder tabId
          session.isCapturing = false; // Not actively capturing
          sessions.set(windowId, session);
        }

        if (!session) return Promise.resolve({ imported: 0 });

        const items = Array.isArray(msg.items) ? msg.items : [];
        let imported = 0;
        for (const it of items) {
          const xml = (it && (it.xml || it)) || '';
          if (!xml || !looksLikeXML(xml)) continue;
          const entry = {
            id: session.nextMessageId++,
            kind: guessKindFromXML(xml),
            transport: 'IMPORT',
            url: 'import://local',
            time: new Date().toISOString(),
            xml: xml.trim(),
            tabId: -1,
            source: 'import'
          };
          if (addMessage(session, entry)) imported++;
        }
        console.log(`${LOG_PREFIX} [Window ${windowId}] Imported ${imported} messages`);
        return Promise.resolve({ imported });
      }
      default:
        return;
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Message handler error:`, error, 'Message type:', msg.type);
    return Promise.reject(error);
  }
});

// Stop capture when tracer window is closed
browser.windows.onRemoved.addListener((windowId) => {
  if (sessions.has(windowId)) {
    console.log(`${LOG_PREFIX} [Window ${windowId}] Window closed, cleaning up session`);
    stopCapture(windowId);
  }
});

// Open window when browser action is clicked
browser.browserAction.onClicked.addListener(async (tab) => {
  try {
    // The tab parameter is the active tab when icon was clicked
    const activeTabId = tab ? tab.id : null;

    if (!activeTabId) {
      console.error(`${LOG_PREFIX} No active tab found`);
      return;
    }

    console.log(`${LOG_PREFIX} Opening new tracer window for tab ${activeTabId}`);

    // Store the target tab ID for the new window
    pendingTargetTab = activeTabId;

    // Create window
    const window = await browser.windows.create({
      url: browser.runtime.getURL('window.html'),
      type: 'popup',
      width: 1000,
      height: 700
    });

    console.log(`${LOG_PREFIX} Tracer window ${window.id} opened for tab ${activeTabId}`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to open window:`, error);
  }
});

console.log(`${LOG_PREFIX} Background script initialized with multi-window support`);
