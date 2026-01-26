let currentView = 'list';

function prettyPrintXML(xml) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    const serializer = new XMLSerializer();
    let formatted = serializer.serializeToString(doc);

    let indent = 0;
    const lines = [];
    formatted.split(/>\s*</).forEach((node, i) => {
      if (i > 0) node = '<' + node;
      if (i < formatted.split(/>\s*</).length - 1) node = node + '>';

      const isClosing = node.match(/^<\//);
      const isSelfClosing = node.match(/\/>$/);

      if (isClosing) indent = Math.max(0, indent - 1);
      lines.push('  '.repeat(indent) + node);
      if (!isClosing && !isSelfClosing) indent++;
    });

    return lines.join('\n');
  } catch (e) {
    return xml;
  }
}

function renderSummary(xml) {
  const data = parseSaml(xml);
  if (!data) return el('div', { class: 'summary' }, 'Unable to parse SAML XML');

  // Define field mappings with labels - only show if value exists
  const fields = [
    { key: 'root', label: 'Type' },
    { key: 'id', label: 'ID' },
    { key: 'issueInstant', label: 'Issue Instant' },
    { key: 'inResponseTo', label: 'InResponseTo' },
    { key: 'issuer', label: 'Issuer' },
    { key: 'destination', label: 'Destination' },
    { key: 'acs', label: 'ACS URL' },
    { key: 'protocolBinding', label: 'Protocol Binding' },
    { key: 'nameIDFormat', label: 'NameID Policy Format' },
    { key: 'allowCreate', label: 'Allow Create' },
    { key: 'subject', label: 'Subject NameID' },
    { key: 'notBefore', label: 'Valid From' },
    { key: 'notOnOrAfter', label: 'Valid To' },
    { key: 'sessionIndex', label: 'Session Index' },
    { key: 'statusCode', label: 'Status Code' },
    { key: 'statusMessage', label: 'Status Message' }
  ];

  // Build kv pairs only for fields with values
  const kvChildren = [];
  for (const field of fields) {
    const value = data[field.key];
    if (value !== null && value !== undefined && value !== '') {
      kvChildren.push(el('div', { class: 'key' }, field.label));
      kvChildren.push(el('div', { class: 'val' }, String(value)));
    }
  }

  // Handle audience (array)
  if (data.audience && data.audience.length > 0) {
    kvChildren.push(el('div', { class: 'key' }, 'Audience'));
    kvChildren.push(el('div', { class: 'val' }, data.audience.join(', ')));
  }

  const kv = el('div', { class: 'kv' }, ...kvChildren);
  const box = el('div', { class: 'summary' }, kv);

  // Show attributes table if present
  if (data.attributes && data.attributes.length) {
    const table = el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Attribute'), el('th', {}, 'Values'))),
      el('tbody', {}, ...data.attributes.map(a => el('tr', {}, el('td', {}, a.name), el('td', {}, a.values.join(', ')))))
    );
    box.appendChild(table);
  }

  return box;
}

function renderList(items, expandedId = null) {
  const list = document.getElementById('list');
  if (!list) return;

  list.innerHTML = '';

  if (!items.length) {
    list.appendChild(el('li', { class: 'empty' }, 'No messages captured yet.'));
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const m of items) {
    const id = `msg-${m.id}`;
    const kindBadge = el('span', { class: `badge ${m.kind === 'SAMLRequest' ? 'kind-request' : 'kind-response'}` },
      m.kind === 'SAMLRequest' ? 'Request' : 'Response');

    // Only show method if it differs from transport, otherwise just show transport
    const transportText = (m.method && m.method !== m.transport)
      ? `${m.method} ${m.transport}`
      : m.transport;

    const transportBadge = el('span', { class: `badge ${m.transport === 'GET' ? 'transport-get' : 'transport-post'}` },
      transportText);
    const toggle = el('button', { class: 'btn btn-ghost toggle-xml', type: 'button' }, 'Show XML');

    const metaChildren = [`${m.time} — `, kindBadge, ' ', transportBadge];

    // Add statusCode if present
    if (m.statusCode) {
      metaChildren.push(' ', el('span', { class: 'badge badge-status' }, `${m.statusCode}`));
    }

    // Add RelayState indicator if present
    if (m.relayState) {
      metaChildren.push(' ', el('span', { class: 'badge badge-relay', title: m.relayState }, 'RelayState'));
    }

    const header = el('div', { class: 'row-header' },
      el('input', { type: 'checkbox', class: 'sel', id }),
      el('label', { for: id, class: 'meta' }, ...metaChildren)
    );
    header.appendChild(toggle);

    const summary = renderSummary(m.xml);
    const prettyXml = prettyPrintXML(m.xml);

    // SECURITY: Use textContent to prevent XSS 
    const pre = document.createElement('pre');
    pre.className = 'xml';
    pre.style.display = 'none';
    pre.textContent = prettyXml;

    const li = el('li', { class: 'row', 'data-id': String(m.id) }, header, summary, pre);

    const shouldExpand = expandedId === m.id;
    if (shouldExpand) {
      pre.style.display = 'block';
      toggle.textContent = 'Hide XML';
    }

    toggle.addEventListener('click', () => {
      const shown = pre.style.display !== 'none';
      pre.style.display = shown ? 'none' : 'block';
      toggle.textContent = shown ? 'Show XML' : 'Hide XML';
    });

    fragment.appendChild(li);
  }

  list.appendChild(fragment);
}

function formatTime(isoString) {
  if (!isoString) return '';
  const time = isoString.split('T')[1];
  return time ? time.slice(0, 12).replace('Z', '') : '';
}

function pickHosts(msgs) {
  // Strategy:
  // Right Column (IdP): The host receiving the FIRST SAMLRequest
  // Left Column (SP): The host receiving the FINAL SAMLResponse (or if none, the host initiating the first SAMLRequest)

  let idP = null;
  let sp = null;

  // 1. Find IdP (dest of first request)
  const firstReq = msgs.find(m => m.kind === 'SAMLRequest');
  if (firstReq) {
    try {
      const u = new URL(firstReq.url);
      idP = u.host;
    } catch (_) { }
  }

  // 2. Find SP (dest of last response)
  const lastRes = [...msgs].reverse().find(m => m.kind === 'SAMLResponse');
  if (lastRes) {
    try {
      const u = new URL(lastRes.url);
      sp = u.host;
    } catch (_) { }
  } else if (firstReq) {
    // Fallback: use the origin of the first request as SP
    try {
      const referer = firstReq.requestHeaders?.Referer;
      if (referer) {
        sp = new URL(referer).host;
      }
    } catch (_) { }
  }

  // Fallbacks
  const right = idP || 'Identity Provider (IdP)';
  const left = sp || (idP ? 'Service Provider (SP)' : 'Service Provider (SP)');

  // If they are strictly equal, try to disambiguate or just show same
  if (left === right && left !== 'Service Provider (SP)') {
    return { left: `${left} (SP)`, right: `${right} (IdP)` };
  }

  return { left, right };
}

function renderFlow(items) {
  const container = document.getElementById('flowContainer');
  if (!container) return;

  container.innerHTML = '';

  if (!items.length) {
    container.appendChild(el('div', { class: 'empty' }, 'No messages captured yet.'));
    return;
  }

  const { left, right } = pickHosts(items);

  const grid = el('div', { class: 'flow-container' });

  grid.appendChild(el('div', { class: 'flow-header', title: left }, left));
  grid.appendChild(el('div', { class: 'flow-header' }, 'Browser'));
  grid.appendChild(el('div', { class: 'flow-header', title: right }, right));

  let step = 1;

  // Determine start node text depending on first message
  const firstKind = items[0].kind;
  const startText = firstKind === 'SAMLRequest' ? 'SP Initiated SSO' : 'IdP Initiated SSO';

  grid.appendChild(el('div', { class: 'flow-message flow-static', style: 'grid-column: 1;' },
    el('div', { class: 'flow-step' }, `${step++}. ${startText}`)
  ));
  grid.appendChild(document.createElement('div'));
  grid.appendChild(document.createElement('div'));

  for (const m of items) {
    const isReq = m.kind === 'SAMLRequest';
    const parsed = parseSaml(m.xml);

    // Determine arrow direction based on destination host
    // Default: Request -> Right (IdP), Response -> Left (SP)
    // But check actual URL against our identified columns
    let arrowDir = isReq ? 'right' : 'left';
    try {
      const u = new URL(m.url);
      if (u.host === right) arrowDir = 'right';
      else if (u.host === left) arrowDir = 'left';
    } catch (_) { }

    const transportText = (m.method && m.method !== m.transport)
      ? `${m.method} ${m.transport}`
      : m.transport;

    const messageContent = el('div', { class: 'flow-msg-content' },
      el('div', { class: 'flow-step' }, `${step++}. ${isReq ? 'SAML Request' : 'SAML Response'}`),
      el('div', { class: 'flow-detail' },
        el('span', { class: 'flow-transport' }, transportText),
        text(' • '),
        el('span', { class: 'flow-time' }, formatTime(m.time)),
        m.statusCode ? text(` • ${m.statusCode}`) : text('')
      )
    );

    if (parsed) {
      if (parsed.issuer) {
        messageContent.appendChild(el('div', { class: 'flow-info' },
          el('span', { class: 'flow-label' }, 'From: '),
          el('span', { class: 'flow-value', title: parsed.issuer }, parsed.issuer)
        ));
      }
      if (parsed.destination) {
        messageContent.appendChild(el('div', { class: 'flow-info' },
          el('span', { class: 'flow-label' }, 'To: '),
          el('span', { class: 'flow-value', title: parsed.destination }, parsed.destination)
        ));
      }
      if (m.relayState) {
        messageContent.appendChild(el('div', { class: 'flow-info' },
          el('span', { class: 'flow-label' }, 'RelayState: '),
          el('span', { class: 'flow-value', title: m.relayState },
            m.relayState.length > 30 ? m.relayState.substring(0, 30) + '...' : m.relayState)
        ));
      }
      // Show extended status for Responses
      if (parsed.statusCode) {
        let statusDisplay = parsed.statusCode.split(':').pop();
        if (parsed.subStatusCode) {
          statusDisplay += ` / ${parsed.subStatusCode.split(':').pop()}`;
        }
        messageContent.appendChild(el('div', { class: 'flow-info' },
          el('span', { class: 'flow-label' }, 'Status: '),
          el('span', { class: 'flow-value', title: parsed.statusCode }, statusDisplay)
        ));
      }
    }

    const box = el('div', {
      class: `flow-message flow-clickable ${isReq ? 'message-req' : 'message-res'}`,
      'data-id': String(m.id)
    }, messageContent);

    const arrow = el('div', { class: `flow-arrow ${arrowDir}` });
    box.appendChild(arrow);

    box.addEventListener('click', () => {
      currentView = 'list';
      document.body.classList.remove('flow-mode');
      refresh(m.id);
    });

    grid.appendChild(document.createElement('div'));
    grid.appendChild(box);
    grid.appendChild(document.createElement('div'));
  }

  // Determine final status block
  const lastMsg = items[items.length - 1];
  let endText = '';
  let endClass = 'flow-static'; // generic grey

  if (lastMsg.kind === 'SAMLResponse') {
    const p = parseSaml(lastMsg.xml);
    const code = p && p.statusCode ? p.statusCode.toLowerCase() : '';
    if (code.includes('success')) {
      endText = 'Full Access Granted';
      endClass = 'badge-response'; // green-ish style via CSS override or similar
    } else {
      endText = 'Sign-on Failed / Incomplete';
      endClass = 'kind-request'; // red/blue warning style
    }
  } else {
    endText = 'Waiting for Response...';
  }

  const endBlock = el('div', { class: `flow-message ${endClass}`, style: 'grid-column: 1;' },
    el('div', { class: 'flow-step' }, `${step++}. ${endText}`)
  );

  if (endText.includes('Granted')) endBlock.style.borderLeft = '4px solid var(--success)';
  else if (endText.includes('Failed')) endBlock.style.borderLeft = '4px solid var(--danger)';

  grid.appendChild(endBlock);
  grid.appendChild(document.createElement('div'));
  grid.appendChild(document.createElement('div'));

  container.appendChild(grid);
}

async function refresh(expandedId = null) {
  try {
    const msgs = await fetchMessages();
    msgs.sort((a, b) => a.id - b.id);

    if (currentView === 'flow') {
      renderFlow(msgs);
    } else {
      renderList(msgs, expandedId);
    }
  } catch (error) {
    console.error('[SAMLView] Refresh failed:', error);
    const messageContainer = document.getElementById('messageContainer');
    if (messageContainer) showError('Failed to refresh messages', messageContainer);
  }
}

const debouncedRefresh = debounce(refresh, 100);

async function exportSelected() {
  const messageContainer = document.getElementById('messageContainer');
  const exportBtn = document.getElementById('exportBtn');

  try {
    if (exportBtn) exportBtn.classList.add('loading');

    const checkboxIds = Array.from(document.querySelectorAll('input.sel:checked')).map(cb => cb.id.replace('msg-', ''));
    const msgs = await fetchMessages();
    const byId = new Map(msgs.map(m => [String(m.id), m]));
    const idsToExport = checkboxIds.length ? checkboxIds : msgs.map(m => String(m.id));

    if (idsToExport.length === 0) {
      if (messageContainer) showError('No messages to export', messageContainer);
      return;
    }

    // Export individual XML files with ordering prefix
    let index = 1;
    for (const id of idsToExport) {
      const m = byId.get(id);
      if (!m) continue;

      const prefix = String(index).padStart(3, '0');
      const kind = m.kind || 'SAML';
      const filename = `${prefix}_${kind}.xml`;

      const blob = new Blob([m.xml], { type: 'application/xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      index++;
      // Small delay between downloads to avoid browser blocking
      if (index <= idsToExport.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    if (messageContainer) showSuccess(`Exported ${index - 1} XML file(s)`, messageContainer);
  } catch (error) {
    console.error('[SAMLView] Export failed:', error);
    if (messageContainer) showError('Export failed', messageContainer);
  } finally {
    if (exportBtn) exportBtn.classList.remove('loading');
  }
}

async function importFromFile(file) {
  const messageContainer = document.getElementById('messageContainer');
  const importBtn = document.getElementById('importBtn');

  try {
    if (importBtn) importBtn.classList.add('loading');

    console.log('[SAMLView] Reading file:', file.name, 'size:', file.size);
    const content = await file.text();
    const trimmed = content.trim();

    // Check if it looks like XML
    if (!trimmed.startsWith('<')) {
      if (messageContainer) showError('File does not appear to be XML', messageContainer);
      return;
    }

    const windowId = await getWindowId();
    const result = await browser.runtime.sendMessage({
      type: 'importMessages',
      windowId,
      items: [{ xml: trimmed }]
    });

    console.log('[SAMLView] Import result:', result);
    await refresh();

    if (result && result.imported > 0) {
      if (messageContainer) showSuccess(`✓ Imported ${file.name}`, messageContainer);
    } else {
      if (messageContainer) showError('Failed to import. Check file format.', messageContainer);
    }
  } catch (error) {
    console.error('[SAMLView] Import failed:', error);
    if (messageContainer) showError(`Import failed: ${error.message || 'Unknown error'}`, messageContainer);
  } finally {
    if (importBtn) importBtn.classList.remove('loading');
  }
}

async function clearAll() {
  const messageContainer = document.getElementById('messageContainer');
  const clearBtn = document.getElementById('clearBtn');

  try {
    if (clearBtn) clearBtn.classList.add('loading');

    const windowId = await getWindowId();
    await browser.runtime.sendMessage({ type: 'clearMessages', windowId });
    await refresh();

    if (messageContainer) showSuccess('Messages cleared', messageContainer);
  } catch (error) {
    console.error('[SAMLView] Clear failed:', error);
    if (messageContainer) showError('Clear failed', messageContainer);
  } finally {
    if (clearBtn) clearBtn.classList.remove('loading');
  }
}

window.toggleFlowView = () => {
  currentView = currentView === 'list' ? 'flow' : 'list';
  document.body.classList.toggle('flow-mode', currentView === 'flow');
  refresh();
};

const clearBtn = document.getElementById('clearBtn');
if (clearBtn) clearBtn.addEventListener('click', clearAll);

const exportBtn = document.getElementById('exportBtn');
if (exportBtn) exportBtn.addEventListener('click', exportSelected);

const importBtn = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');
if (importBtn && importFile) {
  importBtn.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Sort files by name (respects ordering prefix like 001_, 002_, etc.)
    const sortedFiles = Array.from(files).sort((a, b) => a.name.localeCompare(b.name));

    for (const file of sortedFiles) {
      await importFromFile(file);
    }
    importFile.value = '';
  });
}

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg && msg.type === 'messagesUpdated') {
    const windowId = await getWindowId();
    // Only refresh if the message is for this window
    if (msg.windowId === windowId) {
      debouncedRefresh();
    }
  }
});

refresh();
