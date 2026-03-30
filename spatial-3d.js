// spatial-3d.js – 3D-Raumansicht mit Three.js und Gaussian Splatting (Spark.js)

import * as THREE from 'three';

let scene, camera, renderer, controls;
let container3d;
let isInitialized = false;
let sparkModule = null;
let animationFrameId = null;

/**
 * Initialisiert die Three.js-Szene.
 * Wird LAZY aufgerufen — erst wenn der Nutzer 3D nutzen will.
 * @param {HTMLElement} containerEl — Das DOM-Element für den Canvas
 */
export function init3DView(containerEl) {
  if (isInitialized) return;

  container3d = containerEl;
  const width = containerEl.clientWidth;
  const height = containerEl.clientHeight;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f0eb); // ORDO warm bg

  // Camera
  camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
  camera.position.set(0, 2, 5);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  containerEl.appendChild(renderer.domElement);

  // Licht
  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambient);
  const directional = new THREE.DirectionalLight(0xffffff, 0.5);
  directional.position.set(5, 10, 7);
  scene.add(directional);

  // Touch-Steuerung (OrbitControls per CDN)
  setupTouchControls();

  // Resize-Handler
  const resizeObserver = new ResizeObserver(() => {
    const w = containerEl.clientWidth;
    const h = containerEl.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObserver.observe(containerEl);

  // Render-Loop
  function animate() {
    animationFrameId = requestAnimationFrame(animate);
    if (controls) controls.update();
    renderer.render(scene, camera);
  }
  animate();

  isInitialized = true;
}

/**
 * Touch-Steuerung für Mobile.
 * OrbitControls per CDN laden.
 */
async function setupTouchControls() {
  try {
    const { OrbitControls } = await import(
      'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.178.0/examples/jsm/controls/OrbitControls.js'
    );

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2; // Nicht unter den Boden schauen
    controls.minDistance = 1;
    controls.maxDistance = 20;
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
  } catch (err) {
    console.warn('OrbitControls konnten nicht geladen werden:', err);
  }
}

/**
 * Zerstört die 3D-Szene (Cleanup).
 */
export function destroy3DView() {
  if (!isInitialized) return;
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  renderer.dispose();
  scene.clear();
  if (container3d) container3d.innerHTML = '';
  scene = null;
  camera = null;
  renderer = null;
  controls = null;
  container3d = null;
  isInitialized = false;
}

/**
 * Gibt zurück ob WebGL verfügbar ist.
 */
export function isWebGLAvailable() {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/**
 * Lädt einen Gaussian Splat in die Szene.
 * Spark.js wird lazy geladen.
 * @param {string} splatUrl — URL oder Blob-URL zum .spz File
 * @param {Object} position — { x, y, z }
 */
export async function loadSplat(splatUrl, position = { x: 0, y: 0, z: 0 }) {
  if (!isInitialized) {
    console.warn('3D View nicht initialisiert');
    return null;
  }

  // Spark.js lazy laden
  if (!sparkModule) {
    sparkModule = await import('@sparkjsdev/spark');
  }

  const { SplatMesh } = sparkModule;

  const splatMesh = new SplatMesh({ url: splatUrl });
  splatMesh.position.set(position.x, position.y, position.z);
  scene.add(splatMesh);

  // Kamera auf den Splat ausrichten
  camera.position.set(
    position.x,
    position.y + 2,
    position.z + 5
  );
  if (controls) controls.target.set(position.x, position.y, position.z);

  return splatMesh;
}

/**
 * Entfernt alle Splats aus der Szene.
 */
export function clearSplats() {
  if (!scene) return;
  const toRemove = [];
  scene.traverse(child => {
    if (child.isSplatMesh || child.constructor.name === 'SplatMesh') {
      toRemove.push(child);
    }
  });
  toRemove.forEach(obj => {
    scene.remove(obj);
    if (obj.dispose) obj.dispose();
  });
}

/**
 * Lädt ein GLTF/GLB-Modell in die Szene.
 * Für importierte 3D-Scans von Scaniverse/Polycam.
 * @param {File|Blob} gltfFile — Die GLTF/GLB-Datei
 */
export async function loadGLTF(gltfFile) {
  if (!isInitialized) return null;

  // GLTFLoader dynamisch laden
  const { GLTFLoader } = await import(
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.178.0/examples/jsm/loaders/GLTFLoader.js'
  );

  const loader = new GLTFLoader();
  const url = URL.createObjectURL(gltfFile);

  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        scene.add(gltf.scene);

        // Modell zentrieren
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());

        camera.position.set(
          center.x,
          center.y + size.y * 0.5,
          center.z + Math.max(size.x, size.z) * 1.5
        );
        if (controls) controls.target.copy(center);

        URL.revokeObjectURL(url);
        resolve(gltf);
      },
      undefined,
      (error) => {
        URL.revokeObjectURL(url);
        reject(error);
      }
    );
  });
}

/**
 * Prüft ob 3D-Features verfügbar sind.
 * @returns {{ available: boolean, reason: string|null }}
 */
export function check3DAvailability() {
  if (!isWebGLAvailable()) {
    return { available: false, reason: 'WebGL nicht verfügbar' };
  }

  const hasMarble = !!localStorage.getItem('ordo_marble_api_key');

  if (!hasMarble) {
    return {
      available: false,
      reason: 'Marble API Key nötig (Einstellungen) oder 3D-Scan importieren',
    };
  }

  return { available: true, reason: null };
}
