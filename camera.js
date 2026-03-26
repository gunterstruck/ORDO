// camera.js – getUserMedia-basierte Kamera-Erfassung mit erzwungener Rückkamera
// Ersetzt die unzuverlässige capture="environment" HTML-Attribut-Methode

let currentStream = null;
let currentFacingMode = 'environment';
let resolveCapture = null;
let rejectCapture = null;

/**
 * Öffnet die Kamera mit Rückkamera als Standard und gibt ein File-Objekt zurück.
 * Fällt auf den nativen File-Input zurück falls getUserMedia nicht verfügbar ist.
 * @returns {Promise<File|null>} Das aufgenommene Foto als File, oder null bei Abbruch
 */
export async function capturePhoto() {
  // Fallback: getUserMedia nicht verfügbar → nativen Input nutzen
  if (!navigator.mediaDevices?.getUserMedia) {
    return captureViaFileInput();
  }

  return new Promise((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
    currentFacingMode = 'environment';
    startCamera();
  });
}

async function startCamera() {
  const overlay = document.getElementById('camera-overlay');
  const video = document.getElementById('camera-video');

  // Stop any existing stream
  stopStream();

  try {
    // Try exact facingMode first to force rear camera, fall back to ideal if device rejects it
    try {
      currentStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: currentFacingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
    } catch {
      // exact constraint rejected (e.g. device has only one camera) → try ideal
      currentStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: currentFacingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
    }
    video.srcObject = currentStream;
    overlay.style.display = 'flex';
  } catch (err) {
    // Camera access denied or not available → fallback to file input
    stopStream();
    overlay.style.display = 'none';
    const file = await captureViaFileInput();
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

function closeCamera(result) {
  stopStream();
  document.getElementById('camera-overlay').style.display = 'none';
  const cb = resolveCapture;
  resolveCapture = null;
  rejectCapture = null;
  cb?.(result);
}

/**
 * Fallback: nativer File-Input mit capture="environment"
 */
function captureViaFileInput() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
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
    const file = await takeSnapshot();
    closeCamera(file);
  });

  cancelBtn.addEventListener('click', () => {
    closeCamera(null);
  });

  switchBtn.addEventListener('click', async () => {
    currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
    await startCamera();
  });
}
