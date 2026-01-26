let _windowId = null;

// Get current window ID (cached)
async function getWindowId() {
  if (_windowId === null) {
    const win = await browser.windows.getCurrent();
    _windowId = win.id;
  }
  return _windowId;
}

// DOM creation helper
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'for') e.htmlFor = v;
    else if (k === 'style') e.style.cssText = v;
    else if (typeof v === 'boolean') {
      if (v) e.setAttribute(k, '');
    } else {
      e.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function text(t) {
  return document.createTextNode(t);
}

function looksLikeXML(s) {
  if (!s) return false;
  const t = s.trim();
  return t.startsWith('<') || t.startsWith('<?xml');
}

// Fetch messages from background
async function fetchMessages() {
  try {
    const windowId = await getWindowId();
    const res = await browser.runtime.sendMessage({ type: 'getMessages', windowId });
    return res.messages || [];
  } catch (error) {
    console.error('[SAMLView] Failed to fetch messages:', error);
    return [];
  }
}


function attr(elm, name) {
  return elm ? elm.getAttribute(name) : null;
}

// Parse SAML XML into structured data
function parseSaml(xmlStr) {
  try {
    const doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    const root = doc.documentElement;

    // Helper to find node case-insensitively in namespace-agnostic way
    const find = (parent, localName) => {
      // Try exact match first
      const exact = parent.getElementsByTagName(localName);
      if (exact.length) return exact[0];
      // Fallback: iterate (slower but robust for prefixes)
      const all = parent.getElementsByTagName('*');
      for (const el of all) {
        if (el.localName === localName) return el;
      }
      return null;
    };

    const findAll = (parent, localName) => {
      const els = [];
      const all = parent.getElementsByTagName('*');
      for (const el of all) {
        if (el.localName === localName) els.push(el);
      }
      return els;
    };

    const firstVal = (parent, localName) => {
      const n = find(parent, localName);
      return n ? n.textContent.trim() : null;
    };

    const summary = {
      root: root.localName,
      id: attr(root, 'ID'),
      issueInstant: attr(root, 'IssueInstant'),
      inResponseTo: attr(root, 'InResponseTo'),
      destination: attr(root, 'Destination'),
      acs: attr(root, 'AssertionConsumerServiceURL'),
      protocolBinding: attr(root, 'ProtocolBinding'),
      issuer: firstVal(doc, 'Issuer'),
    };

    // Status
    const statusCodeNode = find(doc, 'StatusCode');
    if (statusCodeNode) {
      summary.statusCode = attr(statusCodeNode, 'Value');
      // Handle nested status code
      const nested = find(statusCodeNode, 'StatusCode');
      if (nested) {
        summary.subStatusCode = attr(nested, 'Value');
      }
    }
    const statusMsg = find(doc, 'StatusMessage');
    if (statusMsg) summary.statusMessage = statusMsg.textContent.trim();

    // Subject
    const subject = find(doc, 'Subject');
    if (subject) {
      const nameID = find(subject, 'NameID');
      if (nameID) {
        summary.subject = nameID.textContent.trim();
        summary.nameIDFormat = attr(nameID, 'Format');
        summary.nameIDNameQualifier = attr(nameID, 'NameQualifier');
        summary.nameIDSPNameQualifier = attr(nameID, 'SPNameQualifier');
      }
      const confirmation = find(subject, 'SubjectConfirmation');
      if (confirmation) {
        summary.subjectConfirmationMethod = attr(confirmation, 'Method');
      }
    }

    // Conditions
    const conditions = find(doc, 'Conditions');
    if (conditions) {
      summary.notBefore = attr(conditions, 'NotBefore');
      summary.notOnOrAfter = attr(conditions, 'NotOnOrAfter');
      summary.audience = findAll(conditions, 'Audience').map(n => n.textContent.trim());
    }

    // AuthnStatement / Context
    const authnStmt = find(doc, 'AuthnStatement');
    if (authnStmt) {
      summary.sessionIndex = attr(authnStmt, 'SessionIndex');
      summary.authnInstant = attr(authnStmt, 'AuthnInstant');

      const authnCtx = find(authnStmt, 'AuthnContext');
      if (authnCtx) {
        summary.authnContextClassRef = firstVal(authnCtx, 'AuthnContextClassRef');
        summary.authenticatingAuthority = firstVal(authnCtx, 'AuthenticatingAuthority');
      }
    }

    // Attributes
    summary.attributes = [];
    const attrStmts = findAll(doc, 'AttributeStatement');
    for (const stmt of attrStmts) {
      const attrs = findAll(stmt, 'Attribute');
      for (const a of attrs) {
        const name = attr(a, 'Name') || attr(a, 'FriendlyName') || '(unnamed)';
        const nameFormat = attr(a, 'NameFormat');
        const values = findAll(a, 'AttributeValue').map(v => v.textContent.trim());
        summary.attributes.push({ name, nameFormat, values });
      }
    }

    // NameIDPolicy (for Requests)
    const namePolicy = find(doc, 'NameIDPolicy');
    if (namePolicy) {
      summary.nameIDPolicyFormat = attr(namePolicy, 'Format');
      summary.allowCreate = attr(namePolicy, 'AllowCreate');
    }

    // RequestedAuthnContext (for Requests)
    const reqAuthnCtx = find(doc, 'RequestedAuthnContext');
    if (reqAuthnCtx) {
      summary.reqAuthnContextComparison = attr(reqAuthnCtx, 'Comparison');
      summary.reqAuthnContextClassRefs = findAll(reqAuthnCtx, 'AuthnContextClassRef').map(n => n.textContent.trim());
    }

    return summary;
  } catch (error) {
    console.error('[SAMLView] Failed to parse SAML:', error);
    return null;
  }
}

// Export format constants
const EXPORT_VERSION = '1.0';
const EXPORT_DELIMITER = '----- SAMLVIEW ENTRY -----';

// Split exported XML
function splitExportedXML(text) {
  if (!text) return [];
  const src = String(text).trim();

  // Remove the version header comment if present
  let cleaned = src.replace(/^<!--\s*SAMLView Export Format v[\d.]+\s*-->\s*/i, '');

  // Check for delimiter-based format
  if (cleaned.includes(EXPORT_DELIMITER)) {
    const parts = cleaned.split(new RegExp(`^${EXPORT_DELIMITER}$`, 'm'))
      .map(chunk => {
        // Remove metadata comments and extract XML
        const withoutComments = chunk.replace(/^<!--[\s\S]*?-->\s*/gm, '').trim();
        return withoutComments;
      })
      .filter(s => s && looksLikeXML(s));

    if (parts.length) return parts;
  }

  // Back-compat: split on export header comments
  const headerPattern = /<!--\s*\d{4}-\d{2}-\d{2}.*?\|\s*(SAML(Request|Response)|SAML-XML|SAML)\b[\s\S]*?-->/gm;
  if (headerPattern.test(cleaned)) {
    // Split and remove all comment blocks (create new regex to reset lastIndex)
    const parts = cleaned.split(new RegExp(headerPattern.source, headerPattern.flags))
      .map(s => s.trim())
      .filter(s => s && looksLikeXML(s));
    if (parts.length) return parts;
  }

  // Fallback: extract complete XML documents
  const xmls = [];
  const re = /<([A-Za-z_:][\w:.-]*)\b[\s\S]*?<\/\1>/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const chunk = m[0].trim();
    if (looksLikeXML(chunk)) xmls.push(chunk);
  }

  if (!xmls.length && looksLikeXML(cleaned)) return [cleaned];
  return xmls;
}

// Show user-facing error
function showError(message, container) {
  if (!container) return;
  const errorEl = el('div', { class: 'error-message' },
    el('strong', {}, '⚠ Error: '),
    text(message)
  );
  container.appendChild(errorEl);
  setTimeout(() => errorEl.remove(), 5000);
}

// Show success message
function showSuccess(message, container) {
  if (!container) return;
  const successEl = el('div', { class: 'success-message' },
    el('strong', {}, '✓ '),
    text(message)
  );
  container.appendChild(successEl);
  setTimeout(() => successEl.remove(), 3000);
}

// Debounce helper
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
