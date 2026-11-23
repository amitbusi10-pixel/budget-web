// Test only (loaded by test/run.js, never by the real site): sends the app's Google Drive calls to the
// fake Drive of the test server, and gives the page a test token so it skips the Google sign-in.
'use strict';
(function () {
  const real = window.fetch.bind(window);
  window.fetch = (u, o) => real(typeof u === 'string' && u.startsWith('https://www.googleapis.com') ? window.__FD + u.slice('https://www.googleapis.com'.length) : u, o);
  try { if (!localStorage.getItem('bw-tok') && !sessionStorage.getItem('fd-signedout')) localStorage.setItem('bw-tok', JSON.stringify({ t: 'test-token', exp: Date.now() + 864e5 })); } catch (_) { /* ignore */ }
})();
