
// ── Auth ────────────────────────────────────────────────────────────────────
async function checkAuthStatus() {
  try {
    const res  = await fetch('/api/auth/status');
    const data = await res.json();
    if (data.loggedIn && data.user) {
      currentUser = data.user;
      document.getElementById('auth-overlay').classList.add('hidden');
      // OAuth users who just signed up won't have a username yet
      if (!currentUser.username) {
        document.getElementById('complete-profile-overlay').classList.remove('hidden');
      }
    } else {
      currentUser = null;
      document.getElementById('auth-overlay').classList.remove('hidden');
    }
  } catch (e) {
    console.error('Auth status check failed', e);
    document.getElementById('auth-overlay').classList.remove('hidden');
  }
}

function switchAuthTab(tab) {
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');

  // Show username + confirm-password only on register tab
  const usernameEl = document.getElementById('auth-username');
  const confirmEl  = document.getElementById('auth-confirm-password');
  const emailEl    = document.getElementById('auth-email');
  if (usernameEl) usernameEl.classList.toggle('hidden', tab !== 'register');
  if (confirmEl)  confirmEl.classList.toggle('hidden',  tab !== 'register');
  // On register tab only email is valid; on login tab accept email or username
  if (emailEl) emailEl.placeholder = tab === 'login' ? 'Email or username' : 'Email address';

  document.getElementById('auth-submit-btn').textContent =
    tab === 'login' ? 'Sign In' : 'Create Account';

  document.getElementById('auth-switch').innerHTML = tab === 'login'
    ? `Don't have an account? <a href="#" onclick="switchAuthTab('register'); return false;">Create one</a>`
    : `Already have an account? <a href="#" onclick="switchAuthTab('login'); return false;">Sign In</a>`;

  _clearAuthMsg();
}

function _clearAuthMsg() {
  ['auth-error', 'auth-success'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = ''; el.classList.add('hidden'); }
  });
}

function _showAuthMsg(type, msg) {
  _clearAuthMsg();
  const el = document.getElementById(type === 'error' ? 'auth-error' : 'auth-success');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}

async function submitAuth() {
  const isLogin  = document.getElementById('tab-login').classList.contains('active');
  const email    = (document.getElementById('auth-email').value || '').trim();
  const username = (document.getElementById('auth-username').value || '').trim().toLowerCase();
  const password = document.getElementById('auth-password').value || '';
  const confirm  = (document.getElementById('auth-confirm-password').value || '');
  const btn      = document.getElementById('auth-submit-btn');

  if (!email || !password) { _showAuthMsg('error', 'Please fill in all fields.'); return; }
  if (!isLogin && !username) { _showAuthMsg('error', 'Please choose a username.'); return; }
  if (!isLogin && password.length < 6) { _showAuthMsg('error', 'Password must be at least 6 characters.'); return; }
  if (!isLogin && password !== confirm) { _showAuthMsg('error', 'Passwords do not match.'); return; }

  btn.disabled    = true;
  btn.textContent = isLogin ? 'Signing in…' : 'Creating account…';
  _clearAuthMsg();

  try {
    const body = isLogin ? { email, password } : { email, password, username };
    const res  = await fetch(isLogin ? '/api/auth/login' : '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();

    if (data.ok) {
      if (isLogin) {
        currentUser = data.user;
        document.getElementById('auth-overlay').classList.add('hidden');
      } else {
        _showAuthMsg('success', data.msg || 'Account created! Check your email to verify.');
      }
    } else {
      _showAuthMsg('error', data.msg || 'Something went wrong. Please try again.');
    }
  } catch (e) {
    _showAuthMsg('error', 'Connection error. Please try again.');
  } finally {
    btn.disabled    = false;
    btn.textContent = isLogin ? 'Sign In' : 'Create Account';
  }
}

async function doLogout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  currentUser = null;
  closeSettings();
  document.getElementById('auth-overlay').classList.remove('hidden');
  document.getElementById('complete-profile-overlay').classList.add('hidden');
  switchAuthTab('login');
}

async function signInWithOAuth(provider) {
  _clearAuthMsg();
  try {
    const res  = await fetch(`/api/auth/oauth_url?provider=${provider}`);
    const data = await res.json();
    if (data.ok && data.url) {
      // Redirect this window to the OAuth provider — confirm.html handles the callback
      window.location.href = data.url;
    } else {
      _showAuthMsg('error', data.msg || `Could not start ${provider} login.`);
    }
  } catch (e) {
    _showAuthMsg('error', 'Connection error. Please try again.');
  }
}

async function submitUsername() {
  const input  = document.getElementById('cp-username');
  const errEl  = document.getElementById('cp-error');
  const btn    = document.getElementById('cp-submit-btn');
  const username = (input.value || '').trim().toLowerCase();

  errEl.classList.add('hidden');
  if (!username) { errEl.textContent = 'Please enter a username.'; errEl.classList.remove('hidden'); return; }

  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res  = await fetch('/api/auth/set_username', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const data = await res.json();
    if (data.ok) {
      currentUser.username = username;
      document.getElementById('complete-profile-overlay').classList.add('hidden');
    } else {
      errEl.textContent = data.msg || 'Could not save username. Try a different one.';
      errEl.classList.remove('hidden');
    }
  } catch (e) {
    errEl.textContent = 'Connection error. Please try again.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Create Profile';
  }
}

async function confirmDeleteAccount() {
  // Two-step confirmation so it's hard to do by accident
  const step1 = confirm(
    'This will permanently delete all your manga library data from the cloud.\n\n' +
    'Your local library will NOT be affected.\n\nAre you sure you want to continue?'
  );
  if (!step1) return;

  const step2 = confirm(
    'This cannot be undone. Type OK to confirm deletion of all your cloud data.'
  );
  if (!step2) return;

  try {
    const res  = await fetch('/api/auth/delete_account', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      currentUser = null;
      closeSettings();
      document.getElementById('auth-overlay').classList.remove('hidden');
      switchAuthTab('login');
      alert('Your cloud data has been deleted. You have been signed out.');
    } else {
      alert('Error: ' + (data.msg || 'Could not delete account. Please try again.'));
    }
  } catch (e) {
    alert('Connection error. Please try again.');
  }
}

async function triggerSync() {
  const btns = document.querySelectorAll('#settings-account .nav-btn');
  const syncBtn = [...btns].find(b => b.textContent.includes('Sync'));
  const orig = syncBtn ? syncBtn.textContent : '';
  if (syncBtn) { syncBtn.textContent = 'Syncing…'; syncBtn.disabled = true; }
  try {
    const res  = await fetch('/api/sync', { method: 'POST' });
    const data = await res.json();
    if (syncBtn) syncBtn.textContent = data.ok ? '✔ Synced!' : '✖ Failed';
  } catch (e) {
    if (syncBtn) syncBtn.textContent = '✖ Error';
  } finally {
    setTimeout(() => { if (syncBtn) { syncBtn.textContent = orig; syncBtn.disabled = false; } }, 2500);
  }
}
