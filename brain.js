// brain.js – LocalStorage management and knowledge base

const STORAGE_KEY = 'haushalt_data';
const PHOTO_DB_NAME = 'haushalt_photos';
const PHOTO_DB_VERSION = 1;
const PHOTO_STORE = 'photos';
const MAX_PHOTO_HISTORY = 10;

const Brain = {

  // --- In-Memory Cache ---
  _cache: null,

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
    const exportData = { ...data, version: '1.3', photos };
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
          } catch (err) { if (typeof debugLog === 'function') debugLog(`Import-Foto fehlgeschlagen (${id}): ${err.message}`); }
        }
      }
      return true;
    } catch (err) {
      if (typeof debugLog === 'function') debugLog(`Import fehlgeschlagen: ${err.message}`);
      return false;
    }
  },
  // --- Core Data ---
  getData() {
    if (this._cache) return this._cache;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const data = raw ? JSON.parse(raw) : null;
      if (data) {
        this._cache = data;
        return data;
      }
      return null;
    } catch (err) {
      if (typeof debugLog === 'function') debugLog(`getData: JSON-Parse fehlgeschlagen – ${err.message}`);
      this._cache = null;
      // Corrupted data – reinitialize with fresh structure
      const fresh = {
        version: '1.3',
        created: Date.now(),
        rooms: {},
        chat_history: [],
        last_updated: Date.now()
      };
      this.save(fresh);
      return this._cache;
    }
  },

  // Invalidate cache (used by tests or external changes)
  invalidateCache() {
    this._cache = null;
  },

  save(data) {
    data.last_updated = Date.now();
    this._cache = data;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  },

  init() {
    const existing = this.getData();
    if (!existing) {
      this.save({
        version: '1.3',
        created: Date.now(),
        rooms: {},
        chat_history: [],
        last_updated: Date.now()
      });
    } else if (existing.version === '1.2' || !existing.version) {
      // Upgrade version marker (items migrated lazily on access)
      existing.version = '1.3';
      this.save(existing);
    }
    this.initPhotoDB().catch(err => { if (typeof debugLog === 'function') debugLog(`IndexedDB init fehlgeschlagen: ${err.message}`); });
    // Listen for external changes (other tabs)
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('storage', e => {
        if (e.key === STORAGE_KEY) this._cache = null;
      });
    }
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

  addRoom(roomId, name, emoji, spatial) {
    const data = this.getData();
    if (!data.rooms[roomId]) {
      const room = {
        name,
        emoji: emoji || '🏠',
        containers: {},
        last_updated: Date.now()
      };
      if (spatial) room.spatial = spatial;
      data.rooms[roomId] = room;
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
      // Recursively delete all photos for all containers (including nested)
      this._deleteContainerPhotosRecursive(roomId, room.containers);
    }
    delete data.rooms[roomId];
    this.save(data);
  },

  // Helper: recursively delete photos for containers and their children
  _deleteContainerPhotosRecursive(roomId, containers) {
    for (const [cId, c] of Object.entries(containers || {})) {
      // Delete all history photos
      if (c.photo_history?.length > 0) {
        c.photo_history.forEach(ts => {
          this.deletePhoto(`${roomId}_${cId}_${ts}`).catch(() => {});
        });
      }
      // Delete legacy photo key
      this.deletePhoto(`${roomId}_${cId}`).catch(() => {});
      // Recurse into children
      if (c.containers) {
        this._deleteContainerPhotosRecursive(roomId, c.containers);
      }
    }
  },

  // --- Containers (recursive) ---

  // Get a container by ID – searches recursively through all levels
  // Performs lazy migration of string items to objects
  getContainer(roomId, containerId) {
    const room = this.getRoom(roomId);
    if (!room) return null;
    const c = this._findContainerInTree(room.containers, containerId);
    if (c && this._migrateContainerItems(c)) {
      // Persist migration
      const data = this.getData();
      this.save(data);
    }
    return c;
  },

  // Recursive search through container tree
  _findContainerInTree(containers, containerId) {
    if (!containers) return null;
    if (containers[containerId]) return containers[containerId];
    for (const c of Object.values(containers)) {
      if (c.containers) {
        const found = this._findContainerInTree(c.containers, containerId);
        if (found) return found;
      }
    }
    return null;
  },

  // Find the parent containers map that holds a given containerId
  _findParentContainers(containers, containerId) {
    if (!containers) return null;
    if (containers[containerId]) return containers;
    for (const c of Object.values(containers)) {
      if (c.containers) {
        const found = this._findParentContainers(c.containers, containerId);
        if (found) return found;
      }
    }
    return null;
  },

  // Get container path as array of IDs (for breadcrumbs)
  getContainerPath(roomId, containerId) {
    const room = this.getRoom(roomId);
    if (!room) return [];
    const path = [];
    this._buildPath(room.containers, containerId, path);
    return path;
  },

  _buildPath(containers, targetId, path) {
    if (!containers) return false;
    if (containers[targetId]) {
      path.push(targetId);
      return true;
    }
    for (const [cId, c] of Object.entries(containers)) {
      if (c.containers) {
        path.push(cId);
        if (this._buildPath(c.containers, targetId, path)) return true;
        path.pop();
      }
    }
    return false;
  },

  // Get depth of a container in the tree
  getContainerDepth(roomId, containerId) {
    return this.getContainerPath(roomId, containerId).length - 1;
  },

  // Add container at root level of a room (backwards compatible)
  addContainer(roomId, containerId, name, typ, items, photoAnalyzed, spatial) {
    if (items === undefined) items = [];
    if (!photoAnalyzed) photoAnalyzed = false;
    const data = this.getData();
    if (!data.rooms[roomId]) return;
    const container = {
      name,
      typ: typ || 'sonstiges',
      items: items || [],
      quantities: {},
      last_updated: Date.now(),
      photo_analyzed: photoAnalyzed
    };
    if (spatial) container.spatial = spatial;
    data.rooms[roomId].containers[containerId] = container;
    data.rooms[roomId].last_updated = Date.now();
    this.save(data);
    return data.rooms[roomId].containers[containerId];
  },

  // Add a child container under a parent
  addChildContainer(roomId, parentId, childId, name, typ) {
    const data = this.getData();
    if (!data.rooms[roomId]) return null;
    const parent = this._findContainerInTree(data.rooms[roomId].containers, parentId);
    if (!parent) return null;
    if (!parent.containers) parent.containers = {};
    parent.containers[childId] = {
      name,
      typ: typ || 'sonstiges',
      items: [],
      quantities: {},
      last_updated: Date.now(),
      photo_analyzed: false
    };
    parent.last_updated = Date.now();
    data.rooms[roomId].last_updated = Date.now();
    this.save(data);
    return parent.containers[childId];
  },

  // Move a container under a new parent (or to room root if newParentId is null)
  moveContainer(roomId, containerId, newParentId) {
    const data = this.getData();
    if (!data.rooms[roomId]) return false;

    // Find and remove from current parent
    const currentParent = this._findParentContainers(data.rooms[roomId].containers, containerId);
    if (!currentParent) return false;

    const containerData = currentParent[containerId];
    delete currentParent[containerId];

    if (newParentId) {
      // Move under new parent
      const newParent = this._findContainerInTree(data.rooms[roomId].containers, newParentId);
      if (!newParent) {
        // Rollback
        currentParent[containerId] = containerData;
        return false;
      }
      if (!newParent.containers) newParent.containers = {};
      newParent.containers[containerId] = containerData;
    } else {
      // Move to room root
      data.rooms[roomId].containers[containerId] = containerData;
    }

    data.rooms[roomId].last_updated = Date.now();
    this.save(data);
    return true;
  },

  renameContainer(roomId, containerId, newName) {
    const data = this.getData();
    if (!data.rooms[roomId]) return;
    const c = this._findContainerInTree(data.rooms[roomId].containers, containerId);
    if (c) {
      c.name = newName;
      c.last_updated = Date.now();
      this.save(data);
    }
  },

  deleteContainer(roomId, containerId) {
    const data = this.getData();
    if (!data.rooms[roomId]) return;
    const parent = this._findParentContainers(data.rooms[roomId].containers, containerId);
    if (!parent) return;
    const container = parent[containerId];
    // Delete all nested photos recursively
    if (container) {
      if (container.containers) {
        this._deleteContainerPhotosRecursive(roomId, container.containers);
      }
      if (container.photo_history?.length > 0) {
        container.photo_history.forEach(ts => {
          this.deletePhoto(`${roomId}_${containerId}_${ts}`).catch(() => {});
        });
      }
    }
    delete parent[containerId];
    this.save(data);
    this.deletePhoto(`${roomId}_${containerId}`).catch(() => {});
  },

  // Get all container IDs and names as flat list (for move dialog)
  getAllContainersFlat(roomId, excludeId) {
    const room = this.getRoom(roomId);
    if (!room) return [];
    const result = [];
    this._flattenContainers(room.containers, [], result, excludeId);
    return result;
  },

  _flattenContainers(containers, pathNames, result, excludeId) {
    for (const [cId, c] of Object.entries(containers || {})) {
      if (cId === excludeId) continue;
      const currentPath = [...pathNames, c.name];
      result.push({ id: cId, name: c.name, path: currentPath.join(' > ') });
      if (c.containers) {
        this._flattenContainers(c.containers, currentPath, result, excludeId);
      }
    }
  },

  // --- Item Helpers (v1.3 object format) ---

  // Get item name regardless of format (string or object)
  getItemName(item) {
    return typeof item === 'string' ? item : (item?.name || '');
  },

  // Calculate freshness state based on last_seen timestamp
  // Returns: "fresh" | "stale" | "ghost" | "unconfirmed"
  getItemFreshness(item) {
    if (typeof item === 'string') return 'unconfirmed';
    if (!item || !item.last_seen) return 'unconfirmed';
    const diffMs = Date.now() - new Date(item.last_seen).getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays < 30) return 'fresh';
    if (diffDays < 90) return 'stale';
    return 'ghost';
  },

  // Create a new item object
  createItemObject(name, opts) {
    if (!opts) opts = {};
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, '');
    const item = {
      name,
      status: opts.status || 'aktiv',
      first_seen: opts.first_seen !== undefined ? opts.first_seen : now,
      last_seen: opts.last_seen !== undefined ? opts.last_seen : now,
      seen_count: opts.seen_count || 1,
      menge: opts.menge || 1
    };
    if (opts.spatial) item.spatial = opts.spatial;
    if (opts.object_id) item.object_id = opts.object_id;
    if (opts.crop_ref) item.crop_ref = opts.crop_ref;
    return item;
  },

  // Migrate a single string item to object format
  migrateItem(item, quantities) {
    if (typeof item !== 'string') return item;
    return {
      name: item,
      status: 'aktiv',
      first_seen: null,
      last_seen: null,
      seen_count: 0,
      menge: (quantities && quantities[item] > 1) ? quantities[item] : 1
    };
  },

  // Migrate all items in a container (lazy, in-place)
  _migrateContainerItems(container) {
    if (!container || !container.items) return;
    let migrated = false;
    container.items = container.items.map(item => {
      if (typeof item === 'string') {
        migrated = true;
        return this.migrateItem(item, container.quantities);
      }
      return item;
    });
    return migrated;
  },

  // --- Items (now works with recursive containers) ---
  addItem(roomId, containerId, item) {
    const data = this.getData();
    const c = this._findContainerInTree(data.rooms?.[roomId]?.containers, containerId);
    if (!c) return;
    this._migrateContainerItems(c);
    const exists = c.items.some(i => this.getItemName(i) === item);
    if (!exists) {
      c.items.push(this.createItemObject(item));
      c.last_updated = Date.now();
      this.save(data);
    }
  },

  removeItem(roomId, containerId, item) {
    const data = this.getData();
    const c = this._findContainerInTree(data.rooms?.[roomId]?.containers, containerId);
    if (c) {
      this._migrateContainerItems(c);
      c.items = c.items.filter(i => this.getItemName(i) !== item);
      if (c.quantities) delete c.quantities[item];
      c.last_updated = Date.now();
      this.save(data);
    }
  },

  // Mark a container as having a stored photo
  setContainerHasPhoto(roomId, containerId, value) {
    const data = this.getData();
    const c = this._findContainerInTree(data.rooms?.[roomId]?.containers, containerId);
    if (c) {
      c.has_photo = value;
      this.save(data);
    }
  },

  // Save reviewed items to a container (used by the Review Popup)
  // reviewItems: [{name, menge, checked}]
  addItemsFromReview(roomId, containerId, reviewItems) {
    const data = this.getData();
    const c = this._findContainerInTree(data.rooms?.[roomId]?.containers, containerId);
    if (!c) return 0;
    if (!c.quantities) c.quantities = {};
    this._migrateContainerItems(c);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, '');
    let count = 0;
    (reviewItems || []).forEach(item => {
      if (!item.checked) return;
      const name = (item.name || '').trim();
      if (!name) return;
      const menge = Math.max(1, parseInt(item.menge) || 1);
      const existingIdx = c.items.findIndex(i => this.getItemName(i) === name);
      if (existingIdx >= 0) {
        // Update existing item
        c.items[existingIdx].last_seen = now;
        c.items[existingIdx].seen_count = (c.items[existingIdx].seen_count || 0) + 1;
        c.items[existingIdx].menge = menge;
        c.items[existingIdx].status = 'aktiv';
      } else {
        c.items.push(this.createItemObject(name, { menge, first_seen: now, last_seen: now, seen_count: 1 }));
      }
      // Keep quantities as fallback for old code
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
  // Supports new recursive format with behaelter containing behaelter
  applyPhotoAnalysis(roomId, analysisResult, parentContainerId) {
    const data = this.getData();
    if (!data.rooms[roomId]) return 0;

    let count = 0;
    const targetContainers = parentContainerId
      ? (() => {
          const parent = this._findContainerInTree(data.rooms[roomId].containers, parentContainerId);
          if (parent) {
            if (!parent.containers) parent.containers = {};
            return parent.containers;
          }
          return data.rooms[roomId].containers;
        })()
      : data.rooms[roomId].containers;

    (analysisResult.behaelter || []).forEach(b => {
      const cId = this.slugify(b.id || b.name);
      const sicherItems = b.inhalt_sicher || b.inhalt || [];
      const unsicherItems = (b.inhalt_unsicher || []).map(u =>
        typeof u === 'string' ? u : u.name
      );
      const existing = targetContainers[cId];
      if (existing) {
        // Merge: keep existing items, add new ones (compare by name for v1.3 objects)
        const mergedItems = [...(existing.items || [])];
        const itemNames = mergedItems.map(i => this.getItemName(i));
        sicherItems.forEach(item => {
          if (!itemNames.includes(item)) mergedItems.push(item);
        });
        const mergedUncertain = [...(existing.uncertain_items || [])];
        unsicherItems.forEach(item => {
          if (!mergedUncertain.includes(item) && !itemNames.includes(item)) mergedUncertain.push(item);
        });
        existing.items = mergedItems;
        existing.uncertain_items = mergedUncertain;
        existing.name = b.name || existing.name;
        existing.typ = b.typ || existing.typ;
        existing.last_updated = Date.now();
        existing.photo_analyzed = true;
      } else {
        targetContainers[cId] = {
          name: b.name,
          typ: b.typ || 'sonstiges',
          items: sicherItems,
          uncertain_items: unsicherItems,
          last_updated: Date.now(),
          photo_analyzed: true
        };
      }
      count++;

      // Recursively handle nested containers
      if (b.behaelter?.length > 0) {
        if (!targetContainers[cId].containers) targetContainers[cId].containers = {};
        count += this._applyNestedAnalysis(targetContainers[cId], b.behaelter);
      }
    });

    if (analysisResult.raumhinweis) {
      data.rooms[roomId].hint = analysisResult.raumhinweis;
    }

    data.rooms[roomId].last_updated = Date.now();
    this.save(data);
    return count;
  },

  _applyNestedAnalysis(parentContainer, behaelterList) {
    let count = 0;
    if (!parentContainer.containers) parentContainer.containers = {};
    (behaelterList || []).forEach(b => {
      const cId = this.slugify(b.id || b.name);
      const sicherItems = b.inhalt_sicher || b.inhalt || [];
      const unsicherItems = (b.inhalt_unsicher || []).map(u =>
        typeof u === 'string' ? u : u.name
      );
      const existing = parentContainer.containers[cId];
      if (existing) {
        const mergedItems = [...(existing.items || [])];
        const itemNames = mergedItems.map(i => this.getItemName(i));
        sicherItems.forEach(item => {
          if (!itemNames.includes(item)) mergedItems.push(item);
        });
        const mergedUncertain = [...(existing.uncertain_items || [])];
        unsicherItems.forEach(item => {
          if (!mergedUncertain.includes(item) && !itemNames.includes(item)) mergedUncertain.push(item);
        });
        existing.items = mergedItems;
        existing.uncertain_items = mergedUncertain;
        existing.name = b.name || existing.name;
        existing.typ = b.typ || existing.typ;
        existing.last_updated = Date.now();
        existing.photo_analyzed = true;
      } else {
        parentContainer.containers[cId] = {
          name: b.name,
          typ: b.typ || 'sonstiges',
          items: sicherItems,
          uncertain_items: unsicherItems,
          last_updated: Date.now(),
          photo_analyzed: true
        };
      }
      count++;
      if (b.behaelter?.length > 0) {
        count += this._applyNestedAnalysis(parentContainer.containers[cId], b.behaelter);
      }
    });
    return count;
  },

  // Add a single item as uncertain (shows "?" in brain view)
  addUncertainItem(roomId, containerId, item) {
    const data = this.getData();
    const c = this._findContainerInTree(data.rooms?.[roomId]?.containers, containerId);
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
    const c = this._findContainerInTree(data.rooms?.[roomId]?.containers, containerId);
    if (c) {
      this._migrateContainerItems(c);
      c.uncertain_items = (c.uncertain_items || []).filter(i => i !== item);
      const exists = c.items.some(i => this.getItemName(i) === item);
      if (!exists) c.items.push(this.createItemObject(item));
      c.last_updated = Date.now();
      this.save(data);
    }
  },

  // --- Photo History (Snapshots) ---
  // Save a photo with timestamp, maintaining history
  async savePhotoWithHistory(roomId, containerId, blob) {
    const data = this.getData();
    const c = this._findContainerInTree(data.rooms?.[roomId]?.containers, containerId);
    if (!c) return;

    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, '');
    const photoKey = `${roomId}_${containerId}_${ts}`;

    await this.savePhoto(photoKey, blob);

    if (!c.photo_history) c.photo_history = [];
    c.photo_history.push(ts);

    // Enforce max limit
    const maxPhotos = this.getPhotoHistoryLimit();
    while (c.photo_history.length > maxPhotos) {
      const oldest = c.photo_history.shift();
      this.deletePhoto(`${roomId}_${containerId}_${oldest}`).catch(() => {});
    }

    c.has_photo = true;
    c.last_updated = Date.now();
    this.save(data);

    // Also save under legacy key for backwards compat
    await this.savePhoto(`${roomId}_${containerId}`, blob);

    return ts;
  },

  // Get all photo timestamps for a container
  getPhotoHistory(roomId, containerId) {
    const c = this.getContainer(roomId, containerId);
    return c?.photo_history || [];
  },

  // Get the latest photo key for a container
  getLatestPhotoKey(roomId, containerId) {
    const c = this.getContainer(roomId, containerId);
    if (c?.photo_history?.length > 0) {
      const latest = c.photo_history[c.photo_history.length - 1];
      return `${roomId}_${containerId}_${latest}`;
    }
    // Fallback to legacy key
    return `${roomId}_${containerId}`;
  },

  // Get photo history limit from settings
  getPhotoHistoryLimit() {
    try {
      return parseInt(localStorage.getItem('photo_history_limit')) || MAX_PHOTO_HISTORY;
    } catch { return MAX_PHOTO_HISTORY; }
  },

  setPhotoHistoryLimit(limit) {
    localStorage.setItem('photo_history_limit', String(Math.max(1, Math.min(20, limit))));
  },

  // --- Photo Proof Lookup (with parent fallback) ---
  // Returns { photoKey, timestamp, source } or null
  // source: 'container' | 'parent'
  async findBestPhoto(roomId, containerId) {
    // Priority 1: Container's own photo
    const container = this.getContainer(roomId, containerId);
    if (container?.has_photo || container?.photo_history?.length > 0) {
      const key = this.getLatestPhotoKey(roomId, containerId);
      const blob = await this.getPhoto(key);
      if (blob) {
        const ts = container.photo_history?.length > 0
          ? container.photo_history[container.photo_history.length - 1]
          : null;
        return { photoKey: key, timestamp: ts, source: 'container', blob };
      }
    }
    // Priority 2: Parent container's photo
    const path = this.getContainerPath(roomId, containerId);
    if (path.length >= 2) {
      const parentId = path[path.length - 2];
      const parent = this.getContainer(roomId, parentId);
      if (parent?.has_photo || parent?.photo_history?.length > 0) {
        const key = this.getLatestPhotoKey(roomId, parentId);
        const blob = await this.getPhoto(key);
        if (blob) {
          const ts = parent.photo_history?.length > 0
            ? parent.photo_history[parent.photo_history.length - 1]
            : null;
          return { photoKey: key, timestamp: ts, source: 'parent', blob };
        }
      }
    }
    return null;
  },

  // --- Archive & Lifecycle ---

  archiveItem(roomId, containerId, itemName) {
    const data = this.getData();
    const c = this._findContainerInTree(data.rooms?.[roomId]?.containers, containerId);
    if (!c) return;
    this._migrateContainerItems(c);
    const item = c.items.find(i => this.getItemName(i) === itemName);
    if (item && typeof item === 'object') {
      item.status = 'archiviert';
      item.archived_at = new Date().toISOString().replace(/\.\d{3}Z$/, '');
      c.last_updated = Date.now();
      this.save(data);
    }
  },

  getActiveItems(roomId, containerId) {
    const c = this.getContainer(roomId, containerId);
    if (!c) return [];
    return (c.items || []).filter(item => {
      if (typeof item === 'string') return true;
      return item.status === 'aktiv' || item.status === 'vermisst';
    });
  },

  getArchivedItems(roomId, containerId) {
    const c = this.getContainer(roomId, containerId);
    if (!c) return [];
    return (c.items || []).filter(item => {
      return typeof item !== 'string' && item.status === 'archiviert';
    });
  },

  restoreItem(roomId, containerId, itemName) {
    const data = this.getData();
    const c = this._findContainerInTree(data.rooms?.[roomId]?.containers, containerId);
    if (!c) return;
    this._migrateContainerItems(c);
    const item = c.items.find(i => this.getItemName(i) === itemName);
    if (item && typeof item === 'object') {
      item.status = 'aktiv';
      delete item.archived_at;
      c.last_updated = Date.now();
      this.save(data);
    }
  },

  updateItemsLastSeen(roomId, containerId, itemNames) {
    const data = this.getData();
    const c = this._findContainerInTree(data.rooms?.[roomId]?.containers, containerId);
    if (!c) return;
    this._migrateContainerItems(c);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, '');
    (itemNames || []).forEach(name => {
      const item = c.items.find(i => this.getItemName(i) === name);
      if (item && typeof item === 'object') {
        item.last_seen = now;
        item.seen_count = (item.seen_count || 0) + 1;
      }
    });
    c.last_updated = Date.now();
    this.save(data);
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

  // --- Context for AI (with recursive hierarchy) ---
  buildContext() {
    const rooms = this.getRooms();
    if (Object.keys(rooms).length === 0) return 'Noch keine Haushaltsdaten vorhanden.';

    let ctx = '';
    for (const [rId, room] of Object.entries(rooms)) {
      ctx += `\nRaum: ${room.emoji} ${room.name} [id: ${rId}]`;
      const containers = Object.entries(room.containers || {});
      if (containers.length === 0) {
        ctx += ' (keine Behälter erfasst)';
      } else {
        for (const [cId, c] of containers) {
          ctx += this._buildContainerContext(cId, c, 1);
        }
      }
    }
    return ctx.trim();
  },

  _buildContainerContext(cId, c, depth) {
    const indent = '  '.repeat(depth);
    let ctx = `\n${indent}${c.typ}: ${c.name} [id: ${cId}]`;

    // Filter: only show active and vermisst items
    const activeItems = (c.items || []).filter(item => {
      if (typeof item === 'string') return true;
      return item.status !== 'archiviert';
    });
    const archivedItems = (c.items || []).filter(item => {
      return typeof item !== 'string' && item.status === 'archiviert';
    });

    if (activeItems.length > 0) {
      const itemsStr = activeItems.map(item => {
        const name = this.getItemName(item);
        const menge = typeof item === 'string' ? (c.quantities?.[item] || 1) : (item.menge || 1);
        let str = menge > 1 ? `${menge}x ${name}` : name;
        if (typeof item !== 'string' && item.status === 'vermisst') str += ' (vermisst)';
        return str;
      }).join(', ');
      ctx += ` → ${itemsStr}`;
    } else {
      ctx += ' (leer)';
    }

    // Show last 20 archived items as hint
    if (archivedItems.length > 0) {
      const archiveStr = archivedItems.slice(-20).map(item => {
        let s = item.name;
        if (item.archived_at) s += ` (entfernt am ${this.formatDate(new Date(item.archived_at).getTime())})`;
        return s;
      }).join(', ');
      ctx += `\n${indent}  Archiviert: ${archiveStr}`;
    }

    // Recurse into children
    if (c.containers) {
      for (const [childId, child] of Object.entries(c.containers)) {
        ctx += this._buildContainerContext(childId, child, depth + 1);
      }
    }
    return ctx;
  },

  // Count total containers recursively
  countContainers(containers) {
    let count = 0;
    for (const c of Object.values(containers || {})) {
      count++;
      if (c.containers) {
        count += this.countContainers(c.containers);
      }
    }
    return count;
  },

  // --- Export / Import ---
  async exportData(confirmCallback) {
    const date = new Date().toISOString().slice(0, 10);
    const { exportData, sizeEstimate } = await this.exportWithPhotos();
    const sizeMB = (sizeEstimate / 1024 / 1024).toFixed(1);
    if (sizeEstimate > 10 * 1024 * 1024 && confirmCallback) {
      const ok = await confirmCallback(sizeMB);
      if (!ok) return;
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
    this._cache = null;
    this.deleteAllPhotos().catch(() => {});
    this.init();
  },

  // --- Deduplication / Fuzzy Matching ---

  // Levenshtein distance between two strings
  levenshtein(a, b) {
    if (!a || !b) return Math.max((a || '').length, (b || '').length);
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  },

  // Normalize item name for comparison: lowercase, trim articles, trim whitespace
  normalizeName(name) {
    if (!name) return '';
    let n = name.toLowerCase().trim();
    // Remove German articles
    n = n.replace(/\b(der|die|das|ein|eine|einen|einem|einer|eines)\b/g, '');
    // Remove extra whitespace
    n = n.replace(/\s+/g, ' ').trim();
    return n;
  },

  // Extract core words (sorted) for containment check
  _coreWords(normalized) {
    return normalized.split(/[\s,;:\-–]+/).filter(w => w.length > 1).sort();
  },

  // Check if two item names are a fuzzy match
  isFuzzyMatch(nameA, nameB) {
    if (!nameA || !nameB) return false;
    const a = this.normalizeName(nameA);
    const b = this.normalizeName(nameB);
    if (!a || !b) return false;

    // Exact match after normalization
    if (a === b) return true;

    // Containment check: one name contains the other
    if (a.includes(b) || b.includes(a)) return true;

    // Levenshtein distance < 3
    if (this.levenshtein(a, b) < 3) return true;

    // Word-level comparison: check if core words overlap significantly
    const wordsA = this._coreWords(a);
    const wordsB = this._coreWords(b);
    if (wordsA.length > 0 && wordsB.length > 0) {
      // Check if all words of the shorter set are contained in the longer
      const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
      const longer = wordsA.length <= wordsB.length ? wordsB : wordsA;
      const allContained = shorter.every(w =>
        longer.some(lw => lw.includes(w) || w.includes(lw) || this.levenshtein(w, lw) < 2)
      );
      if (allContained && shorter.length >= longer.length - 1) return true;
    }

    return false;
  },

  // Find a similar item in a container by fuzzy name matching
  findSimilarItem(roomId, containerId, itemName) {
    const c = this.getContainer(roomId, containerId);
    if (!c || !c.items) return null;
    this._migrateContainerItems(c);
    for (const item of c.items) {
      const existingName = this.getItemName(item);
      if (this.isFuzzyMatch(existingName, itemName)) {
        return typeof item === 'object' ? item : { name: item };
      }
    }
    return null;
  },

  // Get milliseconds since container was last updated
  getContainerAge(roomId, containerId) {
    const c = this.getContainer(roomId, containerId);
    if (!c || !c.last_updated) return Infinity;
    return Date.now() - c.last_updated;
  },

  // Check if container was recently photographed (within threshold minutes)
  isRecentlyPhotographed(roomId, containerId, thresholdMinutes) {
    if (thresholdMinutes === undefined) thresholdMinutes = 10;
    const age = this.getContainerAge(roomId, containerId);
    const c = this.getContainer(roomId, containerId);
    if (!c || !c.photo_analyzed) return false;
    return age < thresholdMinutes * 60 * 1000;
  },

  // Get existing item names for a container (for prompt context)
  getContainerItemNames(roomId, containerId) {
    const c = this.getContainer(roomId, containerId);
    if (!c || !c.items) return [];
    this._migrateContainerItems(c);
    return c.items
      .filter(item => typeof item === 'string' || item.status !== 'archiviert')
      .map(item => {
        const name = this.getItemName(item);
        const menge = typeof item === 'object' ? (item.menge || 1) : 1;
        return menge > 1 ? menge + 'x ' + name : name;
      });
  },

  // Update an existing item's last_seen (used for dedup merge)
  updateExistingItem(roomId, containerId, itemName) {
    const data = this.getData();
    const c = this._findContainerInTree(data.rooms?.[roomId]?.containers, containerId);
    if (!c) return false;
    this._migrateContainerItems(c);
    const item = c.items.find(i => this.isFuzzyMatch(this.getItemName(i), itemName));
    if (item && typeof item === 'object') {
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, '');
      item.last_seen = now;
      item.seen_count = (item.seen_count || 0) + 1;
      item.status = 'aktiv';
      c.last_updated = Date.now();
      this.save(data);
      return true;
    }
    return false;
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
  },

  // --- Infrastructure Ignore ---

  addInfrastructureIgnore(roomId, containerId, name) {
    const data = this.getData();
    const c = this._findContainerInTree(data.rooms?.[roomId]?.containers, containerId);
    if (!c) return false;
    if (!c.infrastructure_ignore) c.infrastructure_ignore = [];
    const normalized = (name || '').trim();
    if (!normalized) return false;
    const exists = c.infrastructure_ignore.some(entry => entry.name === normalized);
    if (exists) return false;
    c.infrastructure_ignore.push({
      name: normalized,
      marked_at: new Date().toISOString().replace(/\.\d{3}Z$/, '')
    });
    c.last_updated = Date.now();
    this.save(data);
    this._globalInfraCache = null;
    return true;
  },

  getInfrastructureIgnoreList(roomId, containerId) {
    const c = this.getContainer(roomId, containerId);
    if (!c || !c.infrastructure_ignore) return [];
    return c.infrastructure_ignore.map(entry => entry.name);
  },

  _globalInfraCache: null,

  getGlobalInfrastructure() {
    if (this._globalInfraCache) return this._globalInfraCache;
    const data = this.getData();
    if (!data || !data.rooms) return [];
    const counts = {};
    for (const room of Object.values(data.rooms)) {
      this._collectInfrastructureCounts(room.containers, counts);
    }
    const result = Object.entries(counts)
      .filter(([, count]) => count >= 3)
      .map(([name]) => name);
    this._globalInfraCache = result;
    return result;
  },

  _collectInfrastructureCounts(containers, counts) {
    for (const c of Object.values(containers || {})) {
      if (c.infrastructure_ignore) {
        c.infrastructure_ignore.forEach(entry => {
          counts[entry.name] = (counts[entry.name] || 0) + 1;
        });
      }
      if (c.containers) {
        this._collectInfrastructureCounts(c.containers, counts);
      }
    }
  }
};

// ES Module export (brain.js bleibt inhaltlich unverändert)
export default Brain;
export { STORAGE_KEY, PHOTO_DB_NAME, PHOTO_DB_VERSION, PHOTO_STORE };
