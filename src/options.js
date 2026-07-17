const input = document.getElementById('serverUrl');
const saved = document.getElementById('saved');
const DEFAULT_SERVER = 'http://127.0.0.1:8848';

chrome.storage.local.get('serverUrl').then(({ serverUrl }) => {
  input.value = serverUrl || DEFAULT_SERVER;
});

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ serverUrl: (input.value || DEFAULT_SERVER).trim() });
  saved.style.opacity = '1';
  setTimeout(() => { saved.style.opacity = '0'; }, 1500);
});
