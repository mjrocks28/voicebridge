'use strict';

/* ── Constants ──────────────────────────────────────────────────────────── */
const STORAGE_KEY_API    = 'vb_openai_key';
const STORAGE_KEY_HIST   = 'vb_history';
const STORAGE_KEY_HOK    = 'vb_hokkien';
const OPENAI_CHAT_URL    = 'https://api.openai.com/v1/chat/completions';
const OPENAI_WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

/* ── State ──────────────────────────────────────────────────────────────── */
let activeLang    = 'zh';   // 'zh' | 'en'
let isRecording   = false;
let hokkienMode   = false;
let recognition   = null;
let mediaRecorder = null;
let audioChunks   = [];

/* ── DOM refs ───────────────────────────────────────────────────────────── */
const chatLog          = document.getElementById('chat-log');
const emptyState       = document.getElementById('empty-state');
const speakBtn         = document.getElementById('speak-btn');
const speakLabel       = speakBtn.querySelector('.speak-label');
const btnEn            = document.getElementById('btn-en');
const btnZh            = document.getElementById('btn-zh');
const settingsBtn      = document.getElementById('settings-btn');
const settingsOverlay  = document.getElementById('settings-overlay');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const apiKeyInput      = document.getElementById('api-key-input');
const hokkienToggle    = document.getElementById('hokkien-toggle');
const clearHistoryBtn  = document.getElementById('clear-history-btn');
const saveSettingsBtn  = document.getElementById('save-settings-btn');
const hokkienBadge     = document.getElementById('hokkien-badge');
const browserBanner    = document.getElementById('browser-banner');

/* ── Init ───────────────────────────────────────────────────────────────── */
function init() {
  detectBrowser();
  loadSettings();
  loadHistory();
  bindEvents();
}

function detectBrowser() {
  const ua = navigator.userAgent;
  const isChrome = /Chrome/.test(ua) && !/Edg|OPR|Brave|CriOS/.test(ua);
  if (!isChrome) browserBanner.classList.remove('hidden');
}

function loadSettings() {
  apiKeyInput.value = localStorage.getItem(STORAGE_KEY_API) || '';
  hokkienMode = localStorage.getItem(STORAGE_KEY_HOK) === 'true';
  hokkienToggle.checked = hokkienMode;
  updateHokkienBadge();
}

function loadHistory() {
  const raw = localStorage.getItem(STORAGE_KEY_HIST);
  if (!raw) return;
  try {
    JSON.parse(raw).forEach(e => renderBubbleGroup(e, false));
  } catch { /* corrupted */ }
}

function bindEvents() {
  btnEn.addEventListener('click', () => setActiveLang('en'));
  btnZh.addEventListener('click', () => setActiveLang('zh'));

  settingsBtn.addEventListener('click', openSettings);
  closeSettingsBtn.addEventListener('click', closeSettings);
  settingsOverlay.addEventListener('click', e => { if (e.target === settingsOverlay) closeSettings(); });
  saveSettingsBtn.addEventListener('click', saveSettings);
  clearHistoryBtn.addEventListener('click', clearHistory);

  speakBtn.addEventListener('mousedown',   startSpeaking);
  speakBtn.addEventListener('mouseup',     stopSpeaking);
  speakBtn.addEventListener('mouseleave',  () => { if (isRecording) stopSpeaking(); });
  speakBtn.addEventListener('touchstart',  e => { e.preventDefault(); startSpeaking(); },       { passive: false });
  speakBtn.addEventListener('touchend',    e => { e.preventDefault(); stopSpeaking(); },         { passive: false });
  speakBtn.addEventListener('touchcancel', e => { e.preventDefault(); if (isRecording) stopSpeaking(); }, { passive: false });
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

/* ── Recording state helpers ────────────────────────────────────────────── */
function resetRecordingState() {
  isRecording = false;
  speakBtn.classList.remove('recording');
  speakLabel.textContent = 'Hold to Speak';
}

/* ── Recording orchestration ────────────────────────────────────────────── */
function startSpeaking() {
  if (isRecording) return;
  if (!getApiKey()) {
    alert('Please open Settings and paste your OpenAI API key first.');
    openSettings();
    return;
  }
  isRecording = true;
  speakBtn.classList.add('recording');
  speakLabel.textContent = 'Listening…';

  if (hokkienMode && activeLang === 'zh') {
    startWhisperRecording();
  } else {
    startWebSpeechRecognition();
  }
}

function stopSpeaking() {
  if (!isRecording) return;
  speakLabel.textContent = 'Processing…';

  if (hokkienMode && activeLang === 'zh') {
    stopWhisperRecording();
  } else {
    stopWebSpeechRecognition();
  }
  // Note: isRecording stays true until the recognition actually ends or errors,
  // so the button keeps showing "Processing…" while the API call is in flight.
}

/* ── Web Speech API (STT) ───────────────────────────────────────────────── */
function startWebSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    resetRecordingState();
    showError('Speech recognition is not supported in this browser. Please use Chrome on desktop or Android.');
    return;
  }

  recognition = new SR();
  recognition.lang            = activeLang === 'zh' ? 'zh-TW' : 'en-US';
  recognition.interimResults  = true;   // live feedback while speaking
  recognition.maxAlternatives = 1;
  recognition.continuous      = false;

  // Live-transcript bubble shown while the user speaks
  let liveBubble  = null;
  let liveGroup   = null;
  let lastInterim = '';   // fallback when Chrome omits the final onresult on stop()
  let gotFinal    = false;

  recognition.onresult = e => {
    let interimText = '';
    let finalText   = '';

    for (let i = 0; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t;
      else interimText += t;
    }

    if (interimText) lastInterim = interimText;

    const display = finalText || interimText;

    // Show live bubble
    if (display) {
      emptyState.classList.add('hidden');
      if (!liveGroup) {
        liveGroup  = makeLiveGroup();
        liveBubble = liveGroup.querySelector('.bubble');
        chatLog.appendChild(liveGroup);
      }
      liveBubble.textContent = display;
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    // Final result — hand off to translation pipeline
    if (finalText.trim()) {
      gotFinal = true;
      if (liveGroup) { liveGroup.remove(); liveGroup = null; }
      handleTranscript(finalText.trim());
    }
  };

  recognition.onerror = e => {
    if (liveGroup) { liveGroup.remove(); liveGroup = null; }

    const ignored = ['no-speech', 'aborted'];
    if (!ignored.includes(e.error)) {
      resetRecordingState();
      const msgs = {
        'not-allowed':         'Microphone access denied. Allow mic access in your browser settings and reload.',
        'service-not-allowed': 'Speech recognition service is blocked. Try Chrome on desktop.',
        'audio-capture':       'No microphone found. Please connect a microphone and try again.',
        'language-not-supported': 'Language not supported by this browser\'s speech recognition.',
        'network':             'Network error during speech recognition. Check your connection.',
      };
      showError(msgs[e.error] || 'Speech recognition error: ' + e.error);
    }
  };

  recognition.onend = () => {
    if (liveGroup) { liveGroup.remove(); liveGroup = null; }

    if (isRecording) {
      // User is still holding — restart to keep listening (handles browser auto-stop)
      lastInterim = '';
      gotFinal    = false;
      try { recognition.start(); } catch { /* already restarting */ }
    } else {
      resetRecordingState();
      // Chrome's Chinese STT often skips the final onresult when stop() is called,
      // delivering only interim results. Fall back to the last interim if that happened.
      if (!gotFinal && lastInterim.trim()) {
        handleTranscript(lastInterim.trim());
      }
      lastInterim = '';
      gotFinal    = false;
    }
  };

  try {
    recognition.start();
  } catch (err) {
    resetRecordingState();
    showError('Could not start microphone: ' + err.message);
  }
}

function stopWebSpeechRecognition() {
  if (recognition) {
    // Mark isRecording false BEFORE nulling onend so onend's branch triggers resetRecordingState
    isRecording = false;
    recognition.stop();
    // Don't null recognition here — onend will fire after stop() processes remaining audio
  }
}

function makeLiveGroup() {
  const g = document.createElement('div');
  g.className = `bubble-group ${activeLang} live`;
  const lbl = document.createElement('div');
  lbl.className = 'bubble-label';
  lbl.textContent = activeLang === 'zh' ? (hokkienMode ? '台語 / ZH' : 'ZH') : 'EN';
  const b = document.createElement('div');
  b.className = 'bubble original pending';
  g.appendChild(lbl);
  g.appendChild(b);
  return g;
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
    resetRecordingState();
    showError('Microphone access denied. Allow mic access in your browser settings and reload.');
  }
}

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function stopWhisperRecording() {
  if (!mediaRecorder) { resetRecordingState(); return; }

  isRecording = false;
  mediaRecorder.stop();
  mediaRecorder.stream.getTracks().forEach(t => t.stop());

  mediaRecorder.onstop = async () => {
    resetRecordingState();

    const mimeType = mediaRecorder.mimeType || 'audio/webm';
    const ext      = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    const blob     = new Blob(audioChunks, { type: mimeType });
    audioChunks    = [];
    mediaRecorder  = null;

    if (blob.size < 1000) return;

    const pendingId = addPendingBubble();
    try {
      const transcript = await transcribeWithWhisper(blob, ext);
      removePendingBubble(pendingId);
      if (transcript) await handleTranscript(transcript);
    } catch (err) {
      removePendingBubble(pendingId);
      showError('Transcription failed: ' + err.message);
    }
  };
}

async function transcribeWithWhisper(blob, ext) {
  const key  = getApiKey();
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

  return ((await res.json()).text || '').trim();
}

/* ── Transcript → translate → speak ────────────────────────────────────── */
async function handleTranscript(transcript) {
  try {
    emptyState.classList.add('hidden');

    const isZh     = activeLang === 'zh';
    const sourceLang = isZh
      ? (hokkienMode ? 'Taiwanese Mandarin/Hokkien (台語)' : 'Mandarin Chinese (Traditional)')
      : 'English';
    const targetLang = isZh ? 'English' : 'Mandarin Chinese (Traditional)';

    const entry = { lang: activeLang, original: transcript, translation: null, ts: Date.now() };
    const groupEl = renderBubbleGroup(entry, true);

    try {
      const translation = await translateText(transcript, sourceLang, targetLang);
      entry.translation = translation;
      updateTranslationBubble(groupEl, translation);
      saveEntryToHistory(entry);
      speakTranslation(translation, isZh ? 'en' : 'zh');
    } catch (err) {
      updateTranslationBubble(groupEl, '⚠ Translation failed: ' + err.message);
    }
  } catch (err) {
    showError('Unexpected error: ' + err.message);
  }
}

/* ── OpenAI translation ─────────────────────────────────────────────────── */
async function translateText(text, sourceLang, targetLang) {
  const key = getApiKey();
  if (!key) throw new Error('No API key — open Settings and paste your OpenAI key.');

  let system = `You are a real-time interpreter. Translate the following from ${sourceLang} to ${targetLang}. Return ONLY the translation, no explanation. Preserve tone and formality.`;
  if (hokkienMode && activeLang === 'zh') {
    system += ' The speaker may have used Taiwanese Hokkien (台語). Interpret accordingly before translating.';
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
        { role: 'system', content: system },
        { role: 'user',   content: text  },
      ],
      temperature: 0.3,
      max_tokens: 512,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg  = body.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error('Invalid API key. Check Settings.');
    if (res.status === 429) throw new Error('Rate limited by OpenAI. Wait a moment.');
    throw new Error(msg);
  }

  return ((await res.json()).choices?.[0]?.message?.content || '').trim();
}

/* ── Text-to-speech ─────────────────────────────────────────────────────── */
function speakTranslation(text, targetLang) {
  if (!text || !window.speechSynthesis) return;
  const ss = window.speechSynthesis;

  // If synthesis is paused (Chrome gets stuck after tab switches), unpause first.
  if (ss.paused) ss.resume();
  ss.cancel();

  // Chrome race condition: cancel() is async internally; a setTimeout lets the
  // queue fully flush before we enqueue the new utterance.
  setTimeout(() => {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang  = targetLang === 'zh' ? 'zh-TW' : 'en-US';
    utter.rate  = 0.92;
    ss.speak(utter);
  }, 150);
}

/* ── Pending bubble (Whisper mode) ──────────────────────────────────────── */
let pendingCounter = 0;

function addPendingBubble() {
  const id  = 'pending-' + pendingCounter++;
  const div = document.createElement('div');
  div.className = `bubble-group ${activeLang}`;
  div.id        = id;
  div.innerHTML = `<div class="bubble original pending">Transcribing…</div>`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return id;
}

function removePendingBubble(id) {
  document.getElementById(id)?.remove();
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

  const orig = document.createElement('div');
  orig.className = 'bubble original';
  orig.textContent = entry.original;
  group.appendChild(orig);

  const trans = document.createElement('div');
  trans.className = 'bubble translation' + (isPending ? ' pending' : '');
  trans.textContent = isPending ? 'Translating…' : (entry.translation || '');
  group.appendChild(trans);

  chatLog.appendChild(group);
  chatLog.scrollTop = chatLog.scrollHeight;
  return group;
}

function updateTranslationBubble(groupEl, text) {
  const b = groupEl.querySelector('.bubble.translation');
  if (b) { b.textContent = text; b.classList.remove('pending'); }
  chatLog.scrollTop = chatLog.scrollHeight;
}

/* ── History persistence ─────────────────────────────────────────────────── */
function saveEntryToHistory(entry) {
  let history = [];
  try { history = JSON.parse(localStorage.getItem(STORAGE_KEY_HIST) || '[]'); } catch {}
  history.push(entry);
  if (history.length > 100) history = history.slice(-100);
  localStorage.setItem(STORAGE_KEY_HIST, JSON.stringify(history));
}

/* ── Error display ──────────────────────────────────────────────────────── */
function showError(msg) {
  const div = document.createElement('div');
  div.className = 'bubble-group en';
  const b = document.createElement('div');
  b.className = 'bubble original';
  b.style.cssText = 'background:#4a1e1e;color:#ffaaaa;';
  b.textContent = '⚠ ' + msg;
  div.appendChild(b);
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

/* ── Start ──────────────────────────────────────────────────────────────── */
init();
