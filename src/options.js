const input = document.getElementById('serverUrl');
const tokenInput = document.getElementById('serverToken');
const namesInput = document.getElementById('selfNames');
const jiraInput = document.getElementById('jiraBase');
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
    const voices = await (await fetch(`${serverUrl()}/voices`, { headers: { 'X-MLA-Token': (tokenInput.value || '').trim() } })).json();
    fill(enSel, voices, 'en', selEn, DEFAULT_EN);
    fill(plSel, voices, 'pl', selPl, DEFAULT_PL);
  } catch (_) {
    enSel.innerHTML = plSel.innerHTML = '<option value="">(server offline - can’t list voices)</option>';
  }
}

chrome.storage.local.get(['serverUrl', 'ttsVoiceEn', 'ttsVoicePl', 'mla_token', 'mla_names', 'mla_jira_base']).then((c) => {
  input.value = c.serverUrl || DEFAULT_SERVER;
  tokenInput.value = c.mla_token || '';
  namesInput.value = c.mla_names || '';
  jiraInput.value = c.mla_jira_base !== undefined ? c.mla_jira_base : 'https://your-team.atlassian.net';
  loadVoices(c.ttsVoiceEn || DEFAULT_EN, c.ttsVoicePl || DEFAULT_PL);
});

input.addEventListener('change', () => loadVoices(enSel.value, plSel.value));
tokenInput.addEventListener('change', () => loadVoices(enSel.value, plSel.value));

// One-time mic grant (persists for the extension origin) so the offscreen doc can capture it in co-pilot.
const micState = document.getElementById('micState');
document.getElementById('enableMic').addEventListener('click', async () => {
  micState.textContent = 'requesting…';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    micState.textContent = 'granted ✓';
  } catch (e) {
    micState.textContent = 'denied - allow the mic prompt / check chrome://settings';
  }
});

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ serverUrl: serverUrl(), ttsVoiceEn: enSel.value, ttsVoicePl: plSel.value, mla_token: (tokenInput.value || '').trim(), mla_names: (namesInput.value || '').trim(), mla_jira_base: (jiraInput.value || '').trim() });
  saved.style.opacity = '1';
  setTimeout(() => { saved.style.opacity = '0'; }, 1500);
});
