// Runs on localhost:3000 — injects the extension ID into the page
// so app.js can call chrome.runtime.sendMessage without hardcoding the ID
const meta = document.createElement('meta');
meta.name = 'bchub-extension-id';
meta.content = chrome.runtime.id;

if (document.head) {
  document.head.appendChild(meta);
} else {
  document.addEventListener('DOMContentLoaded', () => document.head.appendChild(meta));
}
