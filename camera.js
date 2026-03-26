// camera.js – getUserMedia-basierte Kamera-Erfassung mit erzwungener Rückkamera
// Ersetzt die unzuverlässige capture="environment" HTML-Attribut-Methode
// Unterstützt Foto-Aufnahme (capturePhoto) und Video-Aufnahme (captureVideo)

let currentStream = null;
let currentFacingMode = 'environment';
let resolveCapture = null;
let rejectCapture = null;

// Video recording state
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = 0;
let recordingTimerInterval = null;
let isVideoMode = false;
let maxVideoDurationSec = 300; // 5 min default

/**
 * Öffnet die Kamera mit Rückkamera als Standard und gibt ein File-Objekt zurück.
 * Fällt auf den nativen File-Input zurück falls getUserMedia nicht verfügbar ist.
 * @returns {Promise<File|null>} Das aufgenommene Foto als File, oder null bei Abbruch
 */
export async function capturePhoto() {
  // Fallback: getUserMedia nicht verfügbar → nativen Input nutzen
  if (!navigator.mediaDevices?.getUserMedia) {
    return captureViaFileInput('image/*');
  }

  return new Promise((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
    isVideoMode = false;
    currentFacingMode = 'environment';
    updateCameraUI();
    startCamera();
  });
}

/**
 * Öffnet die Kamera für Video-Aufnahme mit Rückkamera als Standard.
 * Nutzt MediaRecorder für die Aufnahme.
 * @param {number} maxDurationSec - Maximale Aufnahmedauer in Sekunden (default: 300)
 * @returns {Promise<File|null>} Das aufgenommene Video als File, oder null bei Abbruch
 */
export async function captureVideo(maxDurationSec = 300) {
  // Fallback: getUserMedia oder MediaRecorder nicht verfügbar
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    return captureViaFileInput('video/*');
  }

  maxVideoDurationSec = maxDurationSec;

  return new Promise((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
    isVideoMode = true;
    currentFacingMode = 'environment';
    updateCameraUI();
    startCamera();
  });
}

function updateCameraUI() {
  const shutterBtn = document.getElementById('camera-shutter-btn');
  const timerEl = document.getElementById('camera-record-timer');

  if (!shutterBtn) return;

  if (isVideoMode) {
    shutterBtn.classList.add('camera-shutter-btn--video');
    shutterBtn.setAttribute('aria-label', 'Aufnahme starten');
  } else {
    shutterBtn.classList.remove('camera-shutter-btn--video', 'camera-shutter-btn--recording');
    shutterBtn.setAttribute('aria-label', 'Foto aufnehmen');
  }

  if (timerEl) {
    timerEl.style.display = 'none';
    timerEl.textContent = '0:00';
  }
}

async function startCamera() {
  const overlay = document.getElementById('camera-overlay');
  const video = document.getElementById('camera-video');

  // Stop any existing stream and recording
  stopRecording(true);
  stopStream();

  try {
    // Try exact facingMode first to force rear camera, fall back to ideal if device rejects it
    try {
      currentStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: currentFacingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: isVideoMode
      });
    } catch {
      // exact constraint rejected (e.g. device has only one camera) → try ideal
      currentStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: currentFacingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: isVideoMode
      });
    }
    video.srcObject = currentStream;
    overlay.style.display = 'flex';
  } catch (err) {
    // Camera access denied or not available → fallback to file input
    stopStream();
    overlay.style.display = 'none';
    const accept = isVideoMode ? 'video/*' : 'image/*';
    const file = await captureViaFileInput(accept);
    resolveCapture?.(file);
    resolveCapture = null;
    rejectCapture = null;
  }
}

function stopStream() {
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  const video = document.getElementById('camera-video');
  if (video) video.srcObject = null;
}

function takeSnapshot() {
  const video = document.getElementById('camera-video');
  if (!video || !video.videoWidth) return null;

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  return new Promise(resolve => {
    canvas.toBlob(blob => {
      if (!blob) { resolve(null); return; }
      const file = new File([blob], `foto_${Date.now()}.jpg`, { type: 'image/jpeg' });
      resolve(file);
    }, 'image/jpeg', 0.92);
  });
}

// ── Video Recording ───────────────────────────────────

function startRecording() {
  if (!currentStream || mediaRecorder) return;

  recordedChunks = [];

  // Pick a supported MIME type
  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';

  try {
    mediaRecorder = new MediaRecorder(currentStream, mimeType ? { mimeType } : {});
  } catch {
    mediaRecorder = new MediaRecorder(currentStream);
  }

  mediaRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;

    const actualMime = mediaRecorder.mimeType || 'video/webm';
    const ext = actualMime.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(recordedChunks, { type: actualMime });
    const file = new File([blob], `video_${Date.now()}.${ext}`, { type: actualMime });

    mediaRecorder = null;
    recordedChunks = [];
    closeCamera(file);
  };

  mediaRecorder.onerror = () => {
    stopRecording(true);
    closeCamera(null);
  };

  mediaRecorder.start(1000); // collect data every second
  recordingStartTime = Date.now();

  // Update UI
  const shutterBtn = document.getElementById('camera-shutter-btn');
  shutterBtn.classList.add('camera-shutter-btn--recording');
  shutterBtn.setAttribute('aria-label', 'Aufnahme stoppen');

  const timerEl = document.getElementById('camera-record-timer');
  if (timerEl) {
    timerEl.style.display = '';
    timerEl.textContent = '0:00';
  }

  // Timer update + auto-stop at max duration
  recordingTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    if (timerEl) timerEl.textContent = `${min}:${sec.toString().padStart(2, '0')}`;

    if (elapsed >= maxVideoDurationSec) {
      stopRecording(false);
    }
  }, 500);
}

function stopRecording(discard) {
  clearInterval(recordingTimerInterval);
  recordingTimerInterval = null;

  if (!mediaRecorder) return;

  if (discard) {
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onstop = null;
    try { mediaRecorder.stop(); } catch { /* already stopped */ }
    mediaRecorder = null;
    recordedChunks = [];
  } else {
    // Normal stop → triggers onstop handler which calls closeCamera
    try { mediaRecorder.stop(); } catch { /* already stopped */ }
  }
}

function closeCamera(result) {
  stopRecording(true);
  stopStream();
  const overlay = document.getElementById('camera-overlay');
  if (overlay) overlay.style.display = 'none';

  // Reset UI
  const shutterBtn = document.getElementById('camera-shutter-btn');
  if (shutterBtn) {
    shutterBtn.classList.remove('camera-shutter-btn--video', 'camera-shutter-btn--recording');
  }
  const timerEl = document.getElementById('camera-record-timer');
  if (timerEl) timerEl.style.display = 'none';

  isVideoMode = false;

  const cb = resolveCapture;
  resolveCapture = null;
  rejectCapture = null;
  cb?.(result);
}

/**
 * Fallback: nativer File-Input mit capture="environment"
 */
function captureViaFileInput(accept = 'image/*') {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.capture = 'environment';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files?.[0] || null;
      document.body.removeChild(input);
      resolve(file);
    });
    // Handle cancel (no file selected)
    input.addEventListener('cancel', () => {
      document.body.removeChild(input);
      resolve(null);
    });
    // Fallback: if the input loses focus without a file
    const onFocus = () => {
      window.removeEventListener('focus', onFocus);
      setTimeout(() => {
        if (input.parentNode && !input.files?.length) {
          document.body.removeChild(input);
          resolve(null);
        }
      }, 500);
    };
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

export function setupCamera() {
  const shutterBtn = document.getElementById('camera-shutter-btn');
  const cancelBtn = document.getElementById('camera-cancel-btn');
  const switchBtn = document.getElementById('camera-switch-btn');

  if (!shutterBtn) return;

  shutterBtn.addEventListener('click', async () => {
    if (isVideoMode) {
      // Toggle recording start/stop
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        stopRecording(false); // normal stop → triggers onstop → closeCamera
      } else {
        startRecording();
      }
    } else {
      const file = await takeSnapshot();
      closeCamera(file);
    }
  });

  cancelBtn.addEventListener('click', () => {
    closeCamera(null);
  });

  switchBtn.addEventListener('click', async () => {
    currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
    // If recording, stop and discard before switching
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording(true);
    }
    await startCamera();
  });
}
