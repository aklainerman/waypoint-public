// js/auth/login.js
//
//
// Renders the magic-link login overlay when the user is unauthenticated,
// fetches role from user_roles after sign-in, and wires the topbar chip
// with sign-out. Bootstrapped from the boot IIFE in the still-inline
// classic-script monolith via `await _v135BootAuth()`. The admin tab is
// handled by the sibling js/auth/admin.js module (v181).
//
// Originally at file-scope of the inline monolith (lines 20904-21060 of
// post-v220 source). Pattern matches v181 / v182 (classic-script split,
// top-level declarations stay module-scoped, only the externally-called
// function and shared state object are re-exposed on window).
//
// Exposes on window:
//   window._v135Auth            -- session state object; read by
//                                  js/auth/admin.js (4 callsites)
//   window._authSubscribed  -- one-shot listener guard (also read
//                                  inside _v135BootAuth itself)
//   window._v135BootAuth        -- awaited from the boot IIFE in the
//                                  still-inline monolith
//
// Consumes from realm Global Lexical Environment (provided by the
// still-inline classic-script monolith):
//   _sb               -- Supabase client (`let _sb = null` at line
//                        ~20554 of index.html, populated by
//                        _initSupabase). Resolves through the shared
//                        realm scope chain -- same pattern that
//                        js/auth/admin.js relies on in prod.
//   window.DEMO_MODE  -- demo gate (checked first thing in BootAuth).

// =================================================================
// =================================================================
window._v135Auth = {
  session: null,
  user: null,
  role: 'viewer',
};

async function _v135BootAuth() {
  // Demo mode: skip auth entirely. DEMO_MODE viewers are anonymous; the
  // SDK-level write blocker (set up in _applyDemoMode) + server-side RLS
  // deny-write policies on the DEMO Supabase project together prevent
  // any mutation regardless of role, so granting 'viewer' role to all
  // demo visitors is safe.
  if (window.DEMO_MODE) {
    window._v135Auth.session = null;
    window._v135Auth.user    = null;
    window._v135Auth.role    = 'viewer';
    document.body.classList.add('role-viewer');
    return true;
  }
  // Returns true if the user is signed in (and DB.load may proceed),
  // false if the login modal has been displayed (caller should bail).
  if (!_sb || !_sb.auth) {
    console.error('[v135-auth] Supabase client missing');
    return false;
  }
  // Listen for state changes once so logout/login flips reload the app.
  if (!window._authSubscribed) {
    window._authSubscribed = true;
    _sb.auth.onAuthStateChange(function (event, session) {
      // infinite loop because Supabase fires SIGNED_IN every time it loads
      // a session from localStorage, not just on fresh sign-ins. The boot
      // flow's getSession() handles fresh sessions on its own.
      if (event === 'SIGNED_OUT') {
        window.location.reload();
      }
    });
  }
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) {
    _showLoginModal();
    return false;
  }
  window._v135Auth.session = session;
  window._v135Auth.user    = session.user;
  // Fetch role.
  try {
    const { data, error } = await _sb
      .from('user_roles')
      .select('role')
      .eq('user_id', session.user.id)
      .single();
    if (error && error.code !== 'PGRST116' /* no row */) {
      console.warn('[v135-auth] role lookup failed', error);
    }
    window._v135Auth.role = (data && data.role) || 'viewer';
  } catch (e) {
    console.warn('[v135-auth] role fetch threw', e);
    window._v135Auth.role = 'viewer';
  }
  document.body.classList.add('role-' + window._v135Auth.role);
  _wireUserChip();
  return true;
}
window._v135BootAuth = _v135BootAuth;

function _showLoginModal() {
  // Replace the document body with a centered login card. We don't
  // simply hide the existing UI because the un-authed anon key now
  // returns RLS errors for every table query, and any boot-step that
  // tries to read DB will error noisily.
  const overlay = document.createElement('div');
  overlay.className = 'v135-login-overlay';
  overlay.innerHTML = `
    <div class="v135-login-card">
      <h2>Sign in to Waypoint</h2>
      <p class="v135-login-sub">Enter your work email and we'll send you a one-time sign-in link.</p>
      <label for="v135-email">Email</label>
      <input type="email" id="v135-email" placeholder="you@example.com" autocomplete="email" autofocus />
      <button class="v135-send" id="v135-send">Send sign-in link</button>
      <div class="v135-login-msg" id="v135-msg"></div>
      <div class="v135-login-foot">
        First-time sign-in? Anyone can request a link, but new accounts default to <strong>viewer</strong>.
        An admin must promote you to editor or admin before you can make changes.
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const emailEl = overlay.querySelector('#v135-email');
  const sendBtn = overlay.querySelector('#v135-send');
  const msgEl   = overlay.querySelector('#v135-msg');
  function _setMsg(text, kind) {
    msgEl.textContent = text || '';
    msgEl.className = 'v135-login-msg' + (kind ? ' ' + kind : '');
  }
  async function _send() {
    const email = (emailEl.value || '').trim();
    if (!email || email.indexOf('@') < 0) {
      _setMsg('Enter a valid email address.', 'err');
      return;
    }
    sendBtn.disabled = true;
    _setMsg('Checking authorization...', '');
    try {
      try {
        const chk = await _sb.rpc('is_email_allowed', { p_email: email });
        if (chk && chk.data === false) {
          _setMsg('That email is not authorized. Ask an admin to add you to the Waypoint allowlist.', 'err');
          sendBtn.disabled = false;
          return;
        }
      } catch (_chkErr) { /* RPC may not exist on legacy DBs; fall through */ }
      _setMsg('Sending...', '');
      const redirect = window.location.origin + window.location.pathname;
      const { error } = await _sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirect },
      });
      if (error) throw error;
      _setMsg('Check your email - click the link to sign in.', 'ok');
    } catch (e) {
      console.warn('[v135-auth] send link failed', e);
      _setMsg((e && e.message) || 'Failed to send link.', 'err');
      sendBtn.disabled = false;
    }
  }
  sendBtn.addEventListener('click', _send);
  emailEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') _send();
  });
}

function _wireUserChip() {
  // Find the topbar and append a chip showing email + role + logout.
  const tb = document.getElementById('v98Topbar');
  if (!tb) return;
  if (tb.querySelector('.v135-user-chip')) return;
  const chip = document.createElement('div');
  chip.className = 'v135-user-chip';
  const u = window._v135Auth.user;
  const r = window._v135Auth.role;
  chip.innerHTML =
    '<span class="v135-role">' + r + '</span>' +
    '<span style="opacity:0.7;font-size:11.5px;">' + (u && u.email ? u.email : '') + '</span>' +
    '<button type="button" class="v135-logout" title="Sign out">Logout</button>';
  tb.appendChild(chip);
  chip.querySelector('.v135-logout').addEventListener('click', async function () {
    try {
      await _sb.auth.signOut();
    } finally {
      window.location.reload();
    }
  });
}
