// Pagina di accesso per i browser degli altri dispositivi della rete.

import { applyTheme } from './theme.js';

applyTheme();

const form = document.getElementById('login-form');
const input = document.getElementById('password');
const button = document.getElementById('login-button');
const error = document.getElementById('login-error');

function showError(text) {
  error.textContent = text;
  error.hidden = !text;
  input.setAttribute('aria-invalid', text ? 'true' : 'false');
}

input.addEventListener('input', () => showError(''));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!input.value) { showError('Scrivi la password.'); input.focus(); return; }
  button.disabled = true;
  button.textContent = 'Accesso...';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: input.value }),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (res.ok) { location.replace('/'); return; }
    showError((data && data.error) || `Accesso non riuscito (${res.status}).`);
    input.select();
  } catch (_) {
    showError('SonoPrint non risponde: controlla che il computer sia acceso e nella stessa rete.');
  } finally {
    button.disabled = false;
    button.textContent = 'Entra';
  }
});
