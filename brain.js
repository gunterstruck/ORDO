// brain.js – LocalStorage management and knowledge base

const STORAGE_KEY = 'haushalt_data';
const PHOTO_DB_NAME = 'haushalt_photos';
const PHOTO_DB_VERSION = 1;
const PHOTO_STORE = 'photos';

const Brain = {

  // --- IndexedDB Photo Storage ---
  _photoDB: null,

  async initPhotoDB() {
    if (!('indexedDB' in window)) return;
    return new Promise((resolve) => {
      const req = indexedDB.open(PHOTO_DB_NAME, PHOTO_DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(PHOTO_STORE)) {
          db.createObjectStore(PHOTO_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = e => {
        this._photoDB = e.target.result;
        resolve(this._photoDB);
      };
      req.onerror = () => resolve(null);
    });
  },

  async savePhoto(photoId, blob) {
    if (!this._photoDB) return;
    return new Promise((resolve, reject) => {
      const tx = this._photoDB.transaction(PHOTO_STORE, 'readwrite');
      const store = tx.objectStore(PHOTO_STORE);
      store.put({ id: photoId, blob, ts: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('Foto konnte nicht gespeichert werden. Bitte Speicherplatz freigeben.'));
    });
  },

  async getPhoto(photoId) {
    if (!this._photoDB) return null;
    return new Promise((resolve) => {
      const tx = this._photoDB.transaction(PHOTO_STORE, 'readonly');
      const req = tx.objectStore(PHOTO_STORE).get(photoId);
      req.onsuccess = e => resolve(e.target.result?.blob || null);
      req.onerror = () => resolve(null);
    });
  },

  async deletePhoto(photoId) {
    if (!this._photoDB) return;
    return new Promise((resolve) => {
      const tx = this._photoDB.transaction(PHOTO_STORE, 'readwrite');
      tx.objectStore(PHOTO_STORE).delete(photoId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },

  async deleteAllPhotos() {
    if (!this._photoDB) return;
    return new Promise((resolve) => {
      const tx = this._photoDB.transaction(PHOTO_STORE, 'readwrite');
      tx.objectStore(PHOTO_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },

  async exportWithPhotos() {
    const data = this.getData();
    const photos = {};
    if (this._photoDB) {
      await new Promise((resolve) => {
        const tx = this._photoDB.transaction(PHOTO_STORE, 'readonly');
        const req = tx.objectStore(PHOTO_STORE).getAll();
        req.onsuccess = e => {
          const entries = e.target.result || [];
          let pending = entries.length;
          if (pending === 0) return resolve();
          entries.forEach(entry => {
            const reader = new FileReader();
            reader.onload = ev => {
              photos[entry.id] = ev.target.result;
              pending--;
              if (pending === 0) resolve();
            };
            reader.readAsDataURL(entry.blob);
          });
        };
        req.onerror = () => resolve();
      });
    }
    const exportData = { ...data, version: '1.1', photos };
    const sizeEstimate = JSON.stringify(exportData).length;
    return { exportData, sizeEstimate };
  },

  async importWithPhotos(jsonData) {
    try {
      const data = JSON.parse(jsonData);
      if (!data.version || !data.rooms) throw new Error('Ungültiges Format');
      const photos = data.photos || {};
      const dataWithoutPhotos = { ...data };
      delete dataWithoutPhotos.photos;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(dataWithoutPhotos));
      if (this._photoDB && Object.keys(photos).length > 0) {
        for (const [id, dataUrl] of Object.entries(photos)) {
          try {
            const res = await fetch(dataUrl);
            const blob = await res.blob();
            await this.savePhoto(id, blob);
          } catch { /* skip failed photos */ }
        }
      }
      return true;
    } catch {
      return false;
    }
  },
  // --- Core Data ---
  getData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },

  save(data) {
    data.last_updated = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  },

  init() {
    if (!this.getData()) {
      this.save({
        version: '1.1',
        created: Date.now(),
        rooms: {},
        chat_history: [],
        last_updated: Date.now()
      });
    }
    this.initPhotoDB().catch(() => {});
    return this.getData();
  },

  isEmpty() {
    const data = this.getData();
    return !data || Object.keys(data.rooms || {}).length === 0;
  },

  // --- Rooms ---
  getRooms() {
    return this.getData()?.rooms || {};
  },

  getRoom(roomId) {
    return this.getRooms()[roomId] || null;
  },

  addRoom(roomId, name, emoji) {
    const data = this.getData();
    if (!data.rooms[roomId]) {
      data.rooms[roomId] = {
        name,
        emoji: emoji || '🏠',
        containers: {},
        last_updated: Date.now()
      };
      this.save(data);
    }
    return data.rooms[roomId];
  },

  renameRoom(roomId, newName, newEmoji) {
    const data = this.getData();
    if (data.rooms[roomId]) {
      data.rooms[roomId].name = newName;
      if (newEmoji) data.rooms[roomId].emoji = newEmoji;
      data.rooms[roomId].last_updated = Date.now();
      this.save(data);
    }
  },

  deleteRoom(roomId) {
    const data = this.getData();
    const room = data.rooms[roomId];
    if (room?.containers) {
      for (const cId of Object.keys(room.containers)) {
        this.deletePhoto(`${roomId}_${cId}`).catch(() => {});
      }
    }
    delete data.rooms[roomId];
    this.save(data);
  },

  // --- Containers ---
  getContainer(roomId, containerId) {
    return this.getRoom(roomId)?.containers?.[containerId] || null;
  },

  addContainer(roomId, containerId, name, typ, items = [], photoAnalyzed = false) {
    const data = this.getData();
    if (!data.rooms[roomId]) return;
    data.rooms[roomId].containers[containerId] = {
      name,
      typ: typ || 'sonstiges',
      items: items || [],
      quantities: {},
      last_updated: Date.now(),
      photo_analyzed: photoAnalyzed
    };
    data.rooms[roomId].last_updated = Date.now();
    this.save(data);
    return data.rooms[roomId].containers[containerId];
  },

  renameContainer(roomId, containerId, newName) {
    const data = this.getData();
    if (data.rooms?.[roomId]?.containers?.[containerId]) {
      data.rooms[roomId].containers[containerId].name = newName;
      data.rooms[roomId].containers[containerId].last_updated = Date.now();
      this.save(data);
    }
  },

  deleteContainer(roomId, containerId) {
    const data = this.getData();
    if (data.rooms?.[roomId]?.containers) {
      delete data.rooms[roomId].containers[containerId];
      this.save(data);
      this.deletePhoto(`${roomId}_${containerId}`).catch(() => {});
    }
  },

  // --- Items ---
  addItem(roomId, containerId, item) {
    const data = this.getData();
    const c = data.rooms?.[roomId]?.containers?.[containerId];
    if (c && !c.items.includes(item)) {
      c.items.push(item);
      c.last_updated = Date.now();
      this.save(data);
    }
  },

  removeItem(roomId, containerId, item) {
    const data = this.getData();
    const c = data.rooms?.[roomId]?.containers?.[containerId];
    if (c) {
      c.items = c.items.filter(i => i !== item);
      if (c.quantities) delete c.quantities[item];
      c.last_updated = Date.now();
      this.save(data);
    }
  },

  // Mark a container as having a stored photo
  setContainerHasPhoto(roomId, containerId, value) {
    const data = this.getData();
    const c = data.rooms?.[roomId]?.containers?.[containerId];
    if (c) {
      c.has_photo = value;
      this.save(data);
    }
  },

  // Save reviewed items to a container (used by the Review Popup)
  // reviewItems: [{name, menge, checked}]
  addItemsFromReview(roomId, containerId, reviewItems) {
    const data = this.getData();
    const c = data.rooms?.[roomId]?.containers?.[containerId];
    if (!c) return 0;
    if (!c.quantities) c.quantities = {};
    let count = 0;
    (reviewItems || []).forEach(item => {
      if (!item.checked) return;
      const name = (item.name || '').trim();
      if (!name) return;
      if (!c.items.includes(name)) {
        c.items.push(name);
      }
      const menge = Math.max(1, parseInt(item.menge) || 1);
      if (menge > 1) {
        c.quantities[name] = menge;
      } else {
        delete c.quantities[name];
      }
      count++;
    });
    c.last_updated = Date.now();
    data.rooms[roomId].last_updated = Date.now();
    this.save(data);
    return count;
  },

  // --- Photo Analysis Result ---
  // Supports new format with inhalt_sicher / inhalt_unsicher, as well as legacy inhalt
  applyPhotoAnalysis(roomId, analysisResult) {
    const data = this.getData();
    if (!data.rooms[roomId]) return 0;

    let count = 0;
    (analysisResult.behaelter || []).forEach(b => {
      const cId = this.slugify(b.id || b.name);
      // Support both new format (inhalt_sicher/inhalt_unsicher) and legacy (inhalt)
      const sicherItems = b.inhalt_sicher || b.inhalt || [];
      const unsicherItems = (b.inhalt_unsicher || []).map(u =>
        typeof u === 'string' ? u : u.name
      );
      data.rooms[roomId].containers[cId] = {
        name: b.name,
        typ: b.typ || 'sonstiges',
        items: sicherItems,
        uncertain_items: unsicherItems,
        last_updated: Date.now(),
        photo_analyzed: true
      };
      count++;
    });

    if (analysisResult.raumhinweis) {
      data.rooms[roomId].hint = analysisResult.raumhinweis;
    }

    data.rooms[roomId].last_updated = Date.now();
    this.save(data);
    return count;
  },

  // Add a single item as uncertain (shows "?" in brain view)
  addUncertainItem(roomId, containerId, item) {
    const data = this.getData();
    const c = data.rooms?.[roomId]?.containers?.[containerId];
    if (c) {
      if (!c.uncertain_items) c.uncertain_items = [];
      if (!c.uncertain_items.includes(item)) {
        c.uncertain_items.push(item);
        c.last_updated = Date.now();
        this.save(data);
      }
    }
  },

  // Confirm an uncertain item → moves it to regular items
  confirmUncertainItem(roomId, containerId, item) {
    const data = this.getData();
    const c = data.rooms?.[roomId]?.containers?.[containerId];
    if (c) {
      c.uncertain_items = (c.uncertain_items || []).filter(i => i !== item);
      if (!c.items.includes(item)) c.items.push(item);
      c.last_updated = Date.now();
      this.save(data);
    }
  },

  // --- Chat History ---
  getChatHistory() {
    return this.getData()?.chat_history || [];
  },

  addChatMessage(role, content) {
    const data = this.getData();
    data.chat_history.push({ role, content, ts: Date.now() });
    // keep last 100 messages
    if (data.chat_history.length > 100) {
      data.chat_history = data.chat_history.slice(-100);
    }
    this.save(data);
  },

  clearChatHistory() {
    const data = this.getData();
    data.chat_history = [];
    this.save(data);
  },

  // --- Context for AI ---
  buildContext() {
    const rooms = this.getRooms();
    if (Object.keys(rooms).length === 0) return 'Noch keine Haushaltsdaten vorhanden.';

    let ctx = '';
    for (const [rId, room] of Object.entries(rooms)) {
      ctx += `\nRaum: ${room.emoji} ${room.name}`;
      const containers = Object.entries(room.containers || {});
      if (containers.length === 0) {
        ctx += ' (keine Behälter erfasst)';
      } else {
        for (const [cId, c] of containers) {
          ctx += `\n  ${c.typ}: ${c.name}`;
          if (c.items?.length > 0) {
            const itemsStr = c.items.map(item => {
              const qty = c.quantities?.[item];
              return qty > 1 ? `${qty}x ${item}` : item;
            }).join(', ');
            ctx += ` → ${itemsStr}`;
          } else {
            ctx += ' (leer)';
          }
        }
      }
    }
    return ctx.trim();
  },

  // --- Export / Import ---
  async exportData() {
    const date = new Date().toISOString().slice(0, 10);
    const { exportData, sizeEstimate } = await this.exportWithPhotos();
    const sizeMB = (sizeEstimate / 1024 / 1024).toFixed(1);
    if (sizeEstimate > 10 * 1024 * 1024) {
      if (!confirm(`Die Export-Datei ist ca. ${sizeMB} MB groß (Fotos enthalten). Trotzdem exportieren?`)) return;
    }
    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `haushalt_export_${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  async importData(jsonString) {
    return this.importWithPhotos(jsonString);
  },

  resetAll() {
    localStorage.removeItem(STORAGE_KEY);
    this.deleteAllPhotos().catch(() => {});
    this.init();
  },

  // --- Helpers ---
  slugify(str) {
    return str
      .toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
  },

  formatDate(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  },

  // --- API Key ---
  getApiKey() {
    return localStorage.getItem('gemini_api_key') || '';
  },

  setApiKey(key) {
    localStorage.setItem('gemini_api_key', key.trim());
  }
};
