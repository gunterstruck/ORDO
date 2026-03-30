// voice-input.js – Voice-First Input Pattern
// Zentrale Logik für das Companion-First Eingabe-Paradigma:
// 1. Antippen → Mikrofon startet
// 2. Spracheingabe → KI-Vorschlag
// 3. One-Tap Bestätigung (✔️ / ❌)

const hasSpeech = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

/**
 * Start speech recognition and return transcript.
 * @param {Object} opts
 * @param {string} [opts.lang='de-DE']
 * @param {number} [opts.timeout=10000]
 * @param {function} [opts.onListening] – called when mic is active
 * @param {function} [opts.onDone] – called when mic stops
 * @returns {Promise<string|null>}
 */
export function listenSpeech({ lang = 'de-DE', timeout = 10000, onListening, onDone } = {}) {
  return new Promise((resolve, reject) => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      reject(new Error('no-speech-api'));
      return;
    }

    const rec = new SpeechRecognition();
    rec.lang = lang;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    let settled = false;

    rec.onresult = (e) => {
      if (!settled) { settled = true; resolve(e.results[0][0].transcript); }
    };
    rec.onerror = (e) => {
      if (settled) return;
      settled = true;
      if (e.error === 'no-speech') resolve(null);
      else reject(new Error(e.error || 'unknown'));
    };
    rec.onend = () => {
      if (!settled) { settled = true; resolve(null); }
      onDone?.();
    };

    rec.start();
    onListening?.();
    setTimeout(() => rec.stop(), timeout);
  });
}

/**
 * Creates a voice-first input field element.
 * Returns { el, getValue, setValue, destroy }
 *
 * The field shows as a read-only display with a mic button.
 * Tapping triggers voice recognition → suggestion → confirm/reject.
 * A small keyboard icon allows manual text fallback.
 *
 * @param {Object} opts
 * @param {string} [opts.placeholder='Antippen zum Sprechen…']
 * @param {string} [opts.defaultValue='']
 * @param {string} [opts.prompt] – prompt text shown while listening
 * @param {string} [opts.type] – 'text' (default) or 'select' (passthrough, not voice)
 * @param {Array} [opts.options] – for type=select
 */
export function createVoiceField(opts = {}) {
  const {
    placeholder = 'Antippen zum Sprechen…',
    defaultValue = '',
    prompt = 'Ich höre zu…',
    type,
    options,
  } = opts;

  // For select fields, return a regular select (no voice needed)
  if (type === 'select' && options) {
    const select = document.createElement('select');
    select.className = 'ordo-modal-select';
    options.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === defaultValue) o.selected = true;
      select.appendChild(o);
    });
    return {
      el: select,
      getValue: () => select.value,
      setValue: (v) => { select.value = v; },
      destroy: () => {},
    };
  }

  let currentValue = defaultValue || '';

  // ── Container ──
  const container = document.createElement('div');
  container.className = 'vf-field';

  // ── Display row (read-only value + mic button) ──
  const displayRow = document.createElement('div');
  displayRow.className = 'vf-display-row';

  const display = document.createElement('div');
  display.className = 'vf-display';
  display.textContent = currentValue || placeholder;
  if (!currentValue) display.classList.add('vf-display--placeholder');

  const micBtn = document.createElement('button');
  micBtn.type = 'button';
  micBtn.className = 'vf-mic-btn';
  micBtn.textContent = '🎤';
  micBtn.setAttribute('aria-label', 'Spracheingabe');

  displayRow.appendChild(display);
  displayRow.appendChild(micBtn);
  container.appendChild(displayRow);

  // ── Suggestion row (shown after voice input) ──
  const suggestionRow = document.createElement('div');
  suggestionRow.className = 'vf-suggestion-row';
  suggestionRow.style.display = 'none';

  const suggestionText = document.createElement('div');
  suggestionText.className = 'vf-suggestion-text';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'vf-confirm-btn';
  confirmBtn.textContent = '✔️';
  confirmBtn.setAttribute('aria-label', 'Bestätigen');

  const rejectBtn = document.createElement('button');
  rejectBtn.type = 'button';
  rejectBtn.className = 'vf-reject-btn';
  rejectBtn.textContent = '❌';
  rejectBtn.setAttribute('aria-label', 'Verwerfen');

  suggestionRow.appendChild(suggestionText);
  suggestionRow.appendChild(confirmBtn);
  suggestionRow.appendChild(rejectBtn);
  container.appendChild(suggestionRow);

  // ── Hidden text input (keyboard fallback) ──
  const hiddenInput = document.createElement('input');
  hiddenInput.type = 'text';
  hiddenInput.className = 'vf-hidden-input';
  hiddenInput.style.display = 'none';
  hiddenInput.placeholder = placeholder;
  hiddenInput.value = currentValue;

  const kbBtn = document.createElement('button');
  kbBtn.type = 'button';
  kbBtn.className = 'vf-kb-btn';
  kbBtn.textContent = '⌨️';
  kbBtn.setAttribute('aria-label', 'Tastatur-Eingabe');
  kbBtn.title = 'Tastatur';

  container.appendChild(hiddenInput);
  container.appendChild(kbBtn);

  // ── State ──
  let pendingSuggestion = null;

  function updateDisplay() {
    display.textContent = currentValue || placeholder;
    display.classList.toggle('vf-display--placeholder', !currentValue);
  }

  function showSuggestion(text) {
    pendingSuggestion = text;
    suggestionText.textContent = `„${text}"`;
    suggestionRow.style.display = 'flex';
    displayRow.style.display = 'none';
  }

  function acceptSuggestion() {
    if (pendingSuggestion !== null) {
      currentValue = pendingSuggestion;
      hiddenInput.value = currentValue;
      pendingSuggestion = null;
    }
    suggestionRow.style.display = 'none';
    displayRow.style.display = 'flex';
    updateDisplay();
  }

  function rejectSuggestion() {
    pendingSuggestion = null;
    suggestionRow.style.display = 'none';
    displayRow.style.display = 'flex';
  }

  async function startVoice() {
    if (!hasSpeech) {
      // Fallback: show text input
      showKeyboard();
      return;
    }

    micBtn.classList.add('vf-mic-btn--listening');
    micBtn.textContent = '🔴';
    display.textContent = prompt;
    display.classList.add('vf-display--listening');

    try {
      const transcript = await listenSpeech({
        onDone: () => {
          micBtn.classList.remove('vf-mic-btn--listening');
          micBtn.textContent = '🎤';
          display.classList.remove('vf-display--listening');
        },
      });

      if (transcript) {
        showSuggestion(transcript);
      } else {
        updateDisplay();
      }
    } catch {
      micBtn.classList.remove('vf-mic-btn--listening');
      micBtn.textContent = '🎤';
      display.classList.remove('vf-display--listening');
      updateDisplay();
      // Fallback to keyboard on mic error
      showKeyboard();
    }
  }

  function showKeyboard() {
    hiddenInput.style.display = 'block';
    hiddenInput.value = currentValue;
    hiddenInput.focus();
    kbBtn.style.display = 'none';
  }

  function hideKeyboard() {
    currentValue = hiddenInput.value.trim();
    hiddenInput.style.display = 'none';
    kbBtn.style.display = '';
    updateDisplay();
  }

  // ── Events ──
  micBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startVoice();
  });

  display.addEventListener('click', () => startVoice());

  confirmBtn.addEventListener('click', (e) => {
    e.preventDefault();
    acceptSuggestion();
  });

  rejectBtn.addEventListener('click', (e) => {
    e.preventDefault();
    rejectSuggestion();
  });

  kbBtn.addEventListener('click', (e) => {
    e.preventDefault();
    showKeyboard();
  });

  hiddenInput.addEventListener('blur', () => hideKeyboard());
  hiddenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      hideKeyboard();
    }
  });

  return {
    el: container,
    getValue: () => {
      // If keyboard input is visible, use its value
      if (hiddenInput.style.display !== 'none') {
        return hiddenInput.value.trim();
      }
      return currentValue;
    },
    setValue: (v) => {
      currentValue = v || '';
      hiddenInput.value = currentValue;
      updateDisplay();
    },
    destroy: () => {
      // Cleanup if needed
    },
    focus: () => startVoice(),
  };
}

/**
 * Wraps an existing <input> element with voice-first behavior inline.
 * Used for settings fields that are already in the DOM.
 *
 * @param {HTMLInputElement} inputEl – the existing input
 * @param {Object} opts
 * @param {string} [opts.prompt='Ich höre zu…']
 */
export function wrapInputWithVoice(inputEl, opts = {}) {
  const { prompt = 'Ich höre zu…' } = opts;
  if (!inputEl) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'vf-inline-wrap';

  // Make input read-only by default
  inputEl.readOnly = true;
  inputEl.classList.add('vf-inline-input');

  // Create mic button
  const micBtn = document.createElement('button');
  micBtn.type = 'button';
  micBtn.className = 'vf-inline-mic';
  micBtn.textContent = '🎤';
  micBtn.setAttribute('aria-label', 'Spracheingabe');

  // Create keyboard fallback button
  const kbBtn = document.createElement('button');
  kbBtn.type = 'button';
  kbBtn.className = 'vf-inline-kb';
  kbBtn.textContent = '⌨️';
  kbBtn.setAttribute('aria-label', 'Tastatur');
  kbBtn.title = 'Tastatur';

  // Suggestion bar
  const sugBar = document.createElement('div');
  sugBar.className = 'vf-inline-suggestion';
  sugBar.style.display = 'none';

  const sugText = document.createElement('span');
  sugText.className = 'vf-inline-suggestion-text';

  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'vf-confirm-btn';
  okBtn.textContent = '✔️';

  const noBtn = document.createElement('button');
  noBtn.type = 'button';
  noBtn.className = 'vf-reject-btn';
  noBtn.textContent = '❌';

  sugBar.appendChild(sugText);
  sugBar.appendChild(okBtn);
  sugBar.appendChild(noBtn);

  // Insert wrapper
  inputEl.parentNode.insertBefore(wrapper, inputEl);
  wrapper.appendChild(inputEl);
  wrapper.appendChild(micBtn);
  wrapper.appendChild(kbBtn);
  wrapper.appendChild(sugBar);

  let pendingSuggestion = null;

  async function startVoice() {
    if (!hasSpeech) {
      enableKeyboard();
      return;
    }

    micBtn.classList.add('vf-mic-btn--listening');
    micBtn.textContent = '🔴';
    const oldPlaceholder = inputEl.placeholder;
    inputEl.placeholder = prompt;
    inputEl.value = '';

    try {
      const transcript = await listenSpeech({
        onDone: () => {
          micBtn.classList.remove('vf-mic-btn--listening');
          micBtn.textContent = '🎤';
          inputEl.placeholder = oldPlaceholder;
        },
      });

      if (transcript) {
        pendingSuggestion = transcript;
        sugText.textContent = `„${transcript}"`;
        sugBar.style.display = 'flex';
      }
    } catch {
      micBtn.classList.remove('vf-mic-btn--listening');
      micBtn.textContent = '🎤';
      inputEl.placeholder = oldPlaceholder;
      enableKeyboard();
    }
  }

  function enableKeyboard() {
    inputEl.readOnly = false;
    inputEl.focus();
    kbBtn.style.display = 'none';
    // Re-enable readOnly on blur
    const onBlur = () => {
      inputEl.readOnly = true;
      kbBtn.style.display = '';
      inputEl.removeEventListener('blur', onBlur);
    };
    inputEl.addEventListener('blur', onBlur);
  }

  micBtn.addEventListener('click', (e) => { e.preventDefault(); startVoice(); });
  inputEl.addEventListener('click', () => {
    if (inputEl.readOnly) startVoice();
  });

  kbBtn.addEventListener('click', (e) => { e.preventDefault(); enableKeyboard(); });

  okBtn.addEventListener('click', () => {
    if (pendingSuggestion !== null) {
      inputEl.value = pendingSuggestion;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      pendingSuggestion = null;
    }
    sugBar.style.display = 'none';
  });

  noBtn.addEventListener('click', () => {
    pendingSuggestion = null;
    sugBar.style.display = 'none';
  });
}

export { hasSpeech };
