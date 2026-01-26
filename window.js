async function getTargetTab() {
  try {
    const response = await browser.runtime.sendMessage({ type: 'getTargetTab' });
    return response && response.targetTabId ? response.targetTabId : null;
  } catch (error) {
    console.error('[SAMLView] Failed to get target tab:', error);
    return null;
  }
}

// Populate tab selector dropdown
async function populateTabSelector() {
  const tabSelector = document.getElementById('tabSelector');
  if (!tabSelector) return;

  try {
    const windowId = await getWindowId();
    const [state, tabs] = await Promise.all([
      browser.runtime.sendMessage({ type: 'getState', windowId }),
      browser.tabs.query({ currentWindow: false })
    ]);

    tabSelector.innerHTML = '';

    if (state.capturing) {
      tabSelector.classList.add('status-capturing');
      let captureTabTitle = `Tab ${state.rootTabId}`;
      try {
        const t = await browser.tabs.get(state.rootTabId);
        if (t) captureTabTitle = t.title || t.url || `Tab ${t.id}`;
      } catch (e) {
        console.warn('[SAMLView] Could not get captured tab info:', e.message);
      }

      tabSelector.appendChild(el('option', {
        value: String(state.rootTabId),
        selected: true
      }, `● ${captureTabTitle}`));

      tabSelector.appendChild(el('option', { value: 'stop' }, `○ Stop Capture`));
    } else {
      tabSelector.classList.remove('status-capturing');
      tabSelector.appendChild(el('option', {
        value: '',
        selected: true
      }, `○ Select Tab to Capture`));
    }

    tabSelector.appendChild(el('option', { value: '', disabled: true }, '──────────'));

    for (const tab of tabs) {
      if (state.capturing && tab.id === state.rootTabId) {
        continue;
      }
      const title = tab.title || tab.url || `Tab ${tab.id}`;
      tabSelector.appendChild(el('option', { value: String(tab.id) }, title));
    }
  } catch (error) {
    console.error('[SAMLView] Failed to populate tabs:', error);
    tabSelector.innerHTML = '';
    tabSelector.appendChild(el('option', { value: '' }, 'Error loading tabs'));
  }
}

// Initialize and start capture on target tab
async function initialize() {
  const targetTabId = await getTargetTab();
  const windowId = await getWindowId();
  const messageContainer = document.getElementById('messageContainer');

  console.log('[SAMLView] Window ID:', windowId, 'Initial target tab:', targetTabId);

  try {
    const state = await browser.runtime.sendMessage({ type: 'getState', windowId });

    if (targetTabId && !state.capturing) {
      // Auto-start capture on target tab
      await browser.runtime.sendMessage({ type: 'startCapture', windowId, tabId: targetTabId });
      console.log('[SAMLView] Auto-started capture on tab:', targetTabId);
    } else if (state.capturing) {
      console.log('[SAMLView] Already capturing on tab:', state.rootTabId);
    }

    await populateTabSelector();
  } catch (error) {
    console.error('[SAMLView] Failed to initialize:', error);
    showError('Failed to initialize', messageContainer);
  }
}

// Tab selector change handler
document.getElementById('tabSelector').addEventListener('change', async (e) => {
  const value = e.target.value;
  const messageContainer = document.getElementById('messageContainer');
  const tabSelector = e.target;
  const windowId = await getWindowId();

  try {
    tabSelector.disabled = true;

    if (value === 'stop') {
      await browser.runtime.sendMessage({ type: 'stopCapture', windowId });
      console.log('[SAMLView] Stopped capture');
      showSuccess('✓ Capture stopped', messageContainer);
    } else if (value) {
      const state = await browser.runtime.sendMessage({ type: 'getState', windowId });
      if (value !== String(state.rootTabId)) {
        // Stop existing capture if currently capturing
        if (state.capturing) {
          await browser.runtime.sendMessage({ type: 'stopCapture', windowId });
          console.log('[SAMLView] Stopped previous capture');
        }

        // Start capture on new tab
        const tabId = parseInt(value, 10);
        await browser.runtime.sendMessage({ type: 'startCapture', windowId, tabId });
        console.log('[SAMLView] Started capture on tab:', tabId);
        showSuccess('✓ Switched to new tab', messageContainer);
      }
    }

    await populateTabSelector();
  } catch (error) {
    console.error('[SAMLView] Toggle capture failed:', error);
    showError('Failed to toggle capture', messageContainer);
  } finally {
    tabSelector.disabled = false;
  }
});

// Stop capture handler
document.getElementById('stopCaptureBtn').addEventListener('click', async () => {
  const messageContainer = document.getElementById('messageContainer');
  const windowId = await getWindowId();

  try {
    await browser.runtime.sendMessage({ type: 'stopCapture', windowId });
    console.log('[SAMLView] Stopped capture');
    showSuccess('✓ Capture stopped', messageContainer);
    await populateTabSelector();
  } catch (error) {
    console.error('[SAMLView] Failed to stop capture:', error);
    showError('Failed to stop capture', messageContainer);
  }
});

// Flow view toggle
document.getElementById('flowViewBtn').addEventListener('click', () => {
  if (typeof window.toggleFlowView === 'function') {
    window.toggleFlowView();
    const btn = document.getElementById('flowViewBtn');
    const isFlowMode = document.body.classList.contains('flow-mode');
    btn.textContent = isFlowMode ? 'List View' : 'Diagram';
  }
});

// Listen for message updates
browser.runtime.onMessage.addListener(async (msg) => {
  if (msg && msg.type === 'messagesUpdated') {
    const windowId = await getWindowId();
    // Only update if the message is for this window
    if (msg.windowId === windowId) {
      populateTabSelector();
    }
  }
});

// Dark mode toggle
const themeToggle = document.getElementById('themeToggle');
const sunIcon = themeToggle.querySelector('.sun-icon');
const moonIcon = themeToggle.querySelector('.moon-icon');

// Load saved theme preference (with fallback for private browsing)
let savedTheme = 'dark';
try {
  savedTheme = localStorage.getItem('theme') || 'dark';
} catch (e) {
  console.warn('[SAMLView] localStorage not available, using default theme');
}

if (savedTheme === 'dark') {
  document.documentElement.setAttribute('data-theme', 'dark');
  sunIcon.style.display = 'none';
  moonIcon.style.display = 'block';
}

themeToggle.addEventListener('click', () => {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

  document.documentElement.setAttribute('data-theme', newTheme);
  try {
    localStorage.setItem('theme', newTheme);
  } catch (e) {
    // Ignore localStorage errors in private browsing
  }

  if (newTheme === 'dark') {
    sunIcon.style.display = 'none';
    moonIcon.style.display = 'block';
  } else {
    sunIcon.style.display = 'block';
    moonIcon.style.display = 'none';
  }
});

// Hamburger menu toggle
const menuBtn = document.getElementById('menuBtn');
const menuDropdown = document.getElementById('menuDropdown');

if (menuBtn && menuDropdown) {
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = menuDropdown.style.display !== 'none';
    menuDropdown.style.display = isVisible ? 'none' : 'block';
  });

  document.addEventListener('click', () => {
    menuDropdown.style.display = 'none';
  });

  menuDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

// Refresh tab list when tabs change
browser.tabs.onCreated.addListener(populateTabSelector);
browser.tabs.onRemoved.addListener(populateTabSelector);
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.title) {
    populateTabSelector();
  }
});

// Start initialization
initialize();
