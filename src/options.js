const input = document.getElementById('serverUrl');
const enSel = document.getElementById('ttsVoiceEn');
const plSel = document.getElementById('ttsVoicePl');
const saved = document.getElementById('saved');
const DEFAULT_SERVER = 'http://127.0.0.1:8848';
const DEFAULT_EN = 'Daniel';   // English default (meetings are mostly English)
const DEFAULT_PL = 'Zosia';

function serverUrl() { return (input.value || DEFAULT_SERVER).trim().replace(/\/+$/, ''); }

function fill(sel, voices, prefix, selected, fallback) {
  const matches = voices.filter((v) => v.locale.startsWith(prefix)).sort((a, b) => a.name.localeCompare(b.name));
  sel.innerHTML = '';
  for (const v of matches) {
    const o = document.createElement('option');
    o.value = v.name; o.textContent = `${v.name} (${v.locale})`;
    sel.appendChild(o);
  }
  const want = matches.some((v) => v.name === selected) ? selected
    : (matches.some((v) => v.name === fallback) ? fallback : (matches[0] && matches[0].name));
  if (want) sel.value = want;
}

async function loadVoices(selEn, selPl) {
  try {
    const voices = await (await fetch(`${serverUrl()}/voices`)).json();
    fill(enSel, voices, 'en', selEn, DEFAULT_EN);
    fill(plSel, voices, 'pl', selPl, DEFAULT_PL);
  } catch (_) {
    enSel.innerHTML = plSel.innerHTML = '<option value="">(server offline — can’t list voices)</option>';
  }
}

chrome.storage.local.get(['serverUrl', 'ttsVoiceEn', 'ttsVoicePl']).then((c) => {
  input.value = c.serverUrl || DEFAULT_SERVER;
  loadVoices(c.ttsVoiceEn || DEFAULT_EN, c.ttsVoicePl || DEFAULT_PL);
});

input.addEventListener('change', () => loadVoices(enSel.value, plSel.value));

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ serverUrl: serverUrl(), ttsVoiceEn: enSel.value, ttsVoicePl: plSel.value });
  saved.style.opacity = '1';
  setTimeout(() => { saved.style.opacity = '0'; }, 1500);
});
