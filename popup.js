async function getActiveTabId() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0].id : null;
  } catch (error) {
    console.error('[SAMLView] Failed to get active tab:', error);
    return null;
  }
}

async function refreshState() {
  try {
    const state = await browser.runtime.sendMessage({ type: 'getState' });
    const statusEl = document.getElementById('status');
    const toggleBtn = document.getElementById('toggleBtn');

    let title = null;
    if (state.capturing && state.rootTabId) {
      try {
        const t = await browser.tabs.get(state.rootTabId);
        title = t && t.title ? t.title : null;
      } catch (_) { }
    }

    if (state.capturing) {
      statusEl.textContent = `Capturing${title ? `: ${title}` : ''} (tabs: ${state.trackedCount}, messages: ${state.messageCount})`;
      toggleBtn.textContent = 'Stop Capture';
    } else {
      statusEl.textContent = 'Not capturing';
      toggleBtn.textContent = 'Start Capture';
    }
  } catch (error) {
    console.error('[SAMLView] Failed to refresh state:', error);
    const messageContainer = document.getElementById('messageContainer');
    showError('Failed to refresh status', messageContainer);
  }
}

document.getElementById('toggleBtn').addEventListener('click', async () => {
  const toggleBtn = document.getElementById('toggleBtn');
  const messageContainer = document.getElementById('messageContainer');

  try {
    toggleBtn.classList.add('loading');

    const tabId = await getActiveTabId();
    if (!tabId) {
      showError('Could not get active tab', messageContainer);
      return;
    }

    const state = await browser.runtime.sendMessage({ type: 'getState' });

    if (!state.capturing) {
      await browser.runtime.sendMessage({ type: 'startCapture', tabId });
      showSuccess('Capture started', messageContainer);
    } else {
      await browser.runtime.sendMessage({ type: 'stopCapture' });
      showSuccess('Capture stopped', messageContainer);
    }

    await refreshState();
  } catch (error) {
    console.error('[SAMLView] Toggle capture failed:', error);
    showError('Failed to toggle capture', messageContainer);
  } finally {
    toggleBtn.classList.remove('loading');
  }
});

document.getElementById('flowViewBtn').addEventListener('click', () => {
  if (typeof window.toggleFlowView === 'function') {
    window.toggleFlowView();
  } else {
    console.warn('[SAMLView] toggleFlowView not yet available');
  }
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'messagesUpdated') refreshState();
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

refreshState();
