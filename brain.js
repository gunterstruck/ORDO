// brain.js – LocalStorage management and knowledge base

const STORAGE_KEY = 'haushalt_data';

const Brain = {
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
        version: '1.0',
        created: Date.now(),
        rooms: {},
        chat_history: [],
        last_updated: Date.now()
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
      c.last_updated = Date.now();
      this.save(data);
    }
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
            ctx += ` → ${c.items.join(', ')}`;
          } else {
            ctx += ' (leer)';
          }
        }
      }
    }
    return ctx.trim();
  },

  // --- Export / Import ---
  exportData() {
    const data = this.getData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `haushalt_export_${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  importData(jsonString) {
    try {
      const data = JSON.parse(jsonString);
      if (!data.version || !data.rooms) throw new Error('Ungültiges Format');
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  },

  resetAll() {
    localStorage.removeItem(STORAGE_KEY);
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
