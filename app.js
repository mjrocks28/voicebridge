'use strict';

/* ── Constants ──────────────────────────────────────────────────────────── */
const STORAGE_KEY_API   = 'vb_openai_key';
const STORAGE_KEY_HIST  = 'vb_history';
const STORAGE_KEY_HOK   = 'vb_hokkien';
const OPENAI_CHAT_URL   = 'https://api.openai.com/v1/chat/completions';
const OPENAI_WHISPER_URL= 'https://api.openai.com/v1/audio/transcriptions';

/* ── State ──────────────────────────────────────────────────────────────── */
let activeLang   = 'zh';   // 'zh' | 'en'
let isRecording  = false;
let hokkienMode  = false;
let recognition  = null;
let mediaRecorder= null;
let audioChunks  = [];

/* ── DOM refs ───────────────────────────────────────────────────────────── */
const chatLog         = document.getElementById('chat-log');
const emptyState      = document.getElementById('empty-state');
const speakBtn        = document.getElementById('speak-btn');
const speakLabel      = speakBtn.querySelector('.speak-label');
const btnEn           = document.getElementById('btn-en');
const btnZh           = document.getElementById('btn-zh');
const settingsBtn     = document.getElementById('settings-btn');
const settingsOverlay = document.getElementById('settings-overlay');
const closeSettingsBtn= document.getElementById('close-settings-btn');
const apiKeyInput     = document.getElementById('api-key-input');
const hokkienToggle   = document.getElementById('hokkien-toggle');
const clearHistoryBtn = document.getElementById('clear-history-btn');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const hokkienBadge    = document.getElementById('hokkien-badge');
const browserBanner   = document.getElementById('browser-banner');

/* ── Init ───────────────────────────────────────────────────────────────── */
function init() {
  detectBrowser();
  loadSettings();
  loadHistory();
  bindEvents();
}

function detectBrowser() {
  const isChrome = /Chrome/.test(navigator.userAgent) && !/Edg|OPR|Brave/.test(navigator.userAgent);
  if (!isChrome) browserBanner.classList.remove('hidden');
}

function loadSettings() {
  const key = localStorage.getItem(STORAGE_KEY_API) || '';
  apiKeyInput.value = key;
  hokkienMode = localStorage.getItem(STORAGE_KEY_HOK) === 'true';
  hokkienToggle.checked = hokkienMode;
  updateHokkienBadge();
}

function loadHistory() {
  const raw = localStorage.getItem(STORAGE_KEY_HIST);
  if (!raw) return;
  try {
    const entries = JSON.parse(raw);
    entries.forEach(e => renderBubbleGroup(e, false));
  } catch { /* corrupted, ignore */ }
}

function bindEvents() {
  // Speaker toggle
  btnEn.addEventListener('click', () => setActiveLang('en'));
  btnZh.addEventListener('click', () => setActiveLang('zh'));

  // Settings open/close
  settingsBtn.addEventListener('click', openSettings);
  closeSettingsBtn.addEventListener('click', closeSettings);
  settingsOverlay.addEventListener('click', e => { if (e.target === settingsOverlay) closeSettings(); });

  // Save settings
  saveSettingsBtn.addEventListener('click', saveSettings);

  // Clear history
  clearHistoryBtn.addEventListener('click', clearHistory);

  // Hold-to-speak — touch + mouse
  speakBtn.addEventListener('mousedown',  startSpeaking);
  speakBtn.addEventListener('mouseup',    stopSpeaking);
  speakBtn.addEventListener('mouseleave', stopSpeakingIfRecording);
  speakBtn.addEventListener('touchstart', e => { e.preventDefault(); startSpeaking(); }, { passive: false });
  speakBtn.addEventListener('touchend',   e => { e.preventDefault(); stopSpeaking(); },  { passive: false });
  speakBtn.addEventListener('touchcancel',e => { e.preventDefault(); stopSpeakingIfRecording(); }, { passive: false });
}

/* ── Language toggle ────────────────────────────────────────────────────── */
function setActiveLang(lang) {
  activeLang = lang;
  btnEn.classList.toggle('active', lang === 'en');
  btnZh.classList.toggle('active', lang === 'zh');
}

/* ── Settings ───────────────────────────────────────────────────────────── */
function openSettings() {
  apiKeyInput.value = localStorage.getItem(STORAGE_KEY_API) || '';
  hokkienToggle.checked = hokkienMode;
  settingsOverlay.classList.remove('hidden');
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
}

function saveSettings() {
  const key = apiKeyInput.value.trim();
  if (key) localStorage.setItem(STORAGE_KEY_API, key);
  else localStorage.removeItem(STORAGE_KEY_API);

  hokkienMode = hokkienToggle.checked;
  localStorage.setItem(STORAGE_KEY_HOK, hokkienMode);
  updateHokkienBadge();
  closeSettings();
}

function updateHokkienBadge() {
  hokkienBadge.classList.toggle('hidden', !hokkienMode);
}

function clearHistory() {
  localStorage.removeItem(STORAGE_KEY_HIST);
  chatLog.innerHTML = '';
  chatLog.appendChild(emptyState);
  emptyState.classList.remove('hidden');
  closeSettings();
}

function getApiKey() {
  return localStorage.getItem(STORAGE_KEY_API) || '';
}

/* ── Recording orchestration ────────────────────────────────────────────── */
function startSpeaking() {
  if (isRecording) return;
  const key = getApiKey();
  if (!key) {
    alert('Please enter your OpenAI API key in Settings first.');
    openSettings();
    return;
  }
  isRecording = true;
  speakBtn.classList.add('recording');
  speakLabel.textContent = 'Release to Translate';

  if (hokkienMode && activeLang === 'zh') {
    startWhisperRecording();
  } else {
    startWebSpeechRecognition();
  }
}

function stopSpeaking() {
  if (!isRecording) return;
  isRecording = false;
  speakBtn.classList.remove('recording');
  speakLabel.textContent = 'Hold to Speak';

  if (hokkienMode && activeLang === 'zh') {
    stopWhisperRecording();
  } else {
    stopWebSpeechRecognition();
  }
}

function stopSpeakingIfRecording() {
  if (isRecording) stopSpeaking();
}

/* ── Web Speech API (STT) ───────────────────────────────────────────────── */
function startWebSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert('Speech recognition is not supported in this browser. Try Chrome.');
    isRecording = false;
    speakBtn.classList.remove('recording');
    speakLabel.textContent = 'Hold to Speak';
    return;
  }

  recognition = new SR();
  recognition.lang         = activeLang === 'zh' ? 'zh-TW' : 'en-US';
  recognition.interimResults= false;
  recognition.maxAlternatives = 1;
  recognition.continuous   = false;

  recognition.onresult = e => {
    const transcript = e.results[0][0].transcript.trim();
    if (transcript) handleTranscript(transcript);
  };

  recognition.onerror = e => {
    if (e.error !== 'aborted') console.error('SR error:', e.error);
  };

  recognition.onend = () => {
    // If user is still holding, restart (handles Android's auto-stop)
    if (isRecording) {
      try { recognition.start(); } catch { /* already started */ }
    }
  };

  try { recognition.start(); } catch { /* already running */ }
}

function stopWebSpeechRecognition() {
  if (recognition) {
    recognition.onend = null;
    recognition.stop();
    recognition = null;
  }
}

/* ── Whisper API (STT for Hokkien) ─────────────────────────────────────── */
async function startWhisperRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    const mimeType = getSupportedMimeType();
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.start(100);
  } catch (err) {
    alert('Microphone access denied. Please allow microphone access and try again.');
    isRecording = false;
    speakBtn.classList.remove('recording');
    speakLabel.textContent = 'Hold to Speak';
  }
}

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function stopWhisperRecording() {
  if (!mediaRecorder) return;
  mediaRecorder.stop();
  mediaRecorder.stream.getTracks().forEach(t => t.stop());

  mediaRecorder.onstop = async () => {
    const mimeType = mediaRecorder.mimeType || 'audio/webm';
    const ext      = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    const blob     = new Blob(audioChunks, { type: mimeType });
    audioChunks    = [];
    mediaRecorder  = null;

    if (blob.size < 1000) return; // too short, no speech

    const pendingId = addPendingBubble();
    try {
      const transcript = await transcribeWithWhisper(blob, ext);
      if (transcript) {
        removePendingBubble(pendingId);
        await handleTranscript(transcript);
      } else {
        removePendingBubble(pendingId);
      }
    } catch (err) {
      removePendingBubble(pendingId);
      showError('Transcription failed: ' + err.message);
    }
  };
}

async function transcribeWithWhisper(blob, ext) {
  const key = getApiKey();
  const form = new FormData();
  form.append('file', blob, `audio.${ext}`);
  form.append('model', 'whisper-1');
  form.append('language', 'zh');

  const res = await fetch(OPENAI_WHISPER_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return (data.text || '').trim();
}

/* ── Transcript → translate → speak ────────────────────────────────────── */
async function handleTranscript(transcript) {
  emptyState.classList.add('hidden');

  const sourceLang = activeLang === 'zh'
    ? (hokkienMode ? 'Taiwanese Mandarin/Hokkien (台語)' : 'Mandarin Chinese (Traditional)')
    : 'English';
  const targetLang = activeLang === 'zh' ? 'English' : 'Mandarin Chinese (Traditional)';

  const entry = {
    lang: activeLang,
    original: transcript,
    translation: null,
    ts: Date.now(),
  };

  const groupEl = renderBubbleGroup(entry, true);

  try {
    const translation = await translateText(transcript, sourceLang, targetLang);
    entry.translation = translation;
    updateTranslationBubble(groupEl, translation);
    saveEntryToHistory(entry);
    speakTranslation(translation, activeLang === 'zh' ? 'en' : 'zh');
  } catch (err) {
    updateTranslationBubble(groupEl, '[Translation failed: ' + err.message + ']');
  }
}

/* ── OpenAI translation ─────────────────────────────────────────────────── */
async function translateText(text, sourceLang, targetLang) {
  const key = getApiKey();
  if (!key) throw new Error('No API key configured');

  let systemPrompt = `You are a real-time interpreter. Translate the following from ${sourceLang} to ${targetLang}. Return ONLY the translation, no explanation. Preserve tone and formality.`;

  if (hokkienMode && activeLang === 'zh') {
    systemPrompt += ' The speaker may have used Taiwanese Hokkien (台語). Interpret accordingly before translating.';
  }

  const res = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: text },
      ],
      temperature: 0.3,
      max_tokens: 512,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

/* ── Text-to-speech ─────────────────────────────────────────────────────── */
function speakTranslation(text, targetLang) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();

  const utter = new SpeechSynthesisUtterance(text);
  utter.lang  = targetLang === 'zh' ? 'zh-TW' : 'en-US';
  utter.rate  = 0.95;
  utter.pitch = 1;

  // Prefer a matching voice
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v => v.lang.startsWith(targetLang === 'zh' ? 'zh' : 'en'));
  if (preferred) utter.voice = preferred;

  window.speechSynthesis.speak(utter);
}

// Voices may load async
window.speechSynthesis?.addEventListener('voiceschanged', () => {
  window.speechSynthesis.getVoices(); // preload
});

/* ── Pending bubble (while translating) ─────────────────────────────────── */
let pendingCounter = 0;

function addPendingBubble() {
  const id = 'pending-' + pendingCounter++;
  const div = document.createElement('div');
  div.className = `bubble-group ${activeLang}`;
  div.id = id;
  div.innerHTML = `<div class="bubble original pending">...</div>`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return id;
}

function removePendingBubble(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

/* ── Render bubble group ────────────────────────────────────────────────── */
function renderBubbleGroup(entry, isPending) {
  emptyState.classList.add('hidden');

  const group = document.createElement('div');
  group.className = `bubble-group ${entry.lang}`;

  const label = document.createElement('div');
  label.className = 'bubble-label';
  label.textContent = entry.lang === 'zh' ? (hokkienMode ? '台語 / ZH' : 'ZH') : 'EN';
  group.appendChild(label);

  const origBubble = document.createElement('div');
  origBubble.className = 'bubble original';
  origBubble.textContent = entry.original;
  group.appendChild(origBubble);

  const transBubble = document.createElement('div');
  transBubble.className = 'bubble translation' + (isPending ? ' pending' : '');
  transBubble.textContent = isPending ? 'Translating…' : (entry.translation || '');
  group.appendChild(transBubble);

  chatLog.appendChild(group);
  chatLog.scrollTop = chatLog.scrollHeight;
  return group;
}

function updateTranslationBubble(groupEl, text) {
  const transBubble = groupEl.querySelector('.bubble.translation');
  if (transBubble) {
    transBubble.textContent = text;
    transBubble.classList.remove('pending');
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

/* ── History persistence ─────────────────────────────────────────────────── */
function saveEntryToHistory(entry) {
  let history = [];
  try { history = JSON.parse(localStorage.getItem(STORAGE_KEY_HIST) || '[]'); } catch {}
  history.push(entry);
  // Keep last 100 entries
  if (history.length > 100) history = history.slice(-100);
  localStorage.setItem(STORAGE_KEY_HIST, JSON.stringify(history));
}

/* ── Error display ──────────────────────────────────────────────────────── */
function showError(msg) {
  const div = document.createElement('div');
  div.className = 'bubble-group en';
  div.innerHTML = `<div class="bubble original" style="background:#4a1e1e;color:#ffaaaa;">${escapeHtml(msg)}</div>`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ── Start ──────────────────────────────────────────────────────────────── */
init();
