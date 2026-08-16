(() => {
  'use strict';

  const DB_NAME = 'rebecca-feed-planner';
  const DB_VERSION = 5;
  const DATA_VERSION = 5;
  const POSTS_STORE = 'posts';
  const META_STORE = 'meta';
  const INITIAL_COUNT = 14;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const els = {
    grid: $('#feedGrid'),
    empty: $('#emptyState'),
    count: $('#postCount'),
    menuButton: $('#plannerMenuButton'),
    sheet: $('#plannerSheet'),
    backdrop: $('#backdrop'),
    addButton: $('#addPostButton'),
    editButton: $('#editFeedButton'),
    exportButton: $('#exportButton'),
    importButton: $('#importButton'),
    resetButton: $('#resetButton'),
    editorBar: $('#editorBar'),
    finishEdit: $('#finishEditButton'),
    photoInput: $('#photoInput'),
    backupInput: $('#backupInput'),
    createModal: $('#createModal'),
    cancelCreate: $('#cancelCreateButton'),
    savePost: $('#savePostButton'),
    chooseMore: $('#chooseMoreButton'),
    cropStage: $('#cropStage'),
    cropImage: $('#cropImage'),
    zoom: $('#zoomRange'),
    selectedThumbs: $('#selectedThumbs'),
    selectedCount: $('#selectedCount'),
    coverSummary: $('#coverSummary'),
    setCover: $('#setCoverButton'),
    toast: $('#toast'),
    viewer: $('#postViewer'),
    viewerMedia: $('#viewerMedia'),
    viewerDots: $('#viewerDots'),
    closeViewer: $('#closeViewerButton'),
    storageStatus: $('#storageStatus')
  };

  let db;
  let posts = [];
  let editMode = false;
  let selection = [];
  let activeSelectionIndex = 0;
  let coverSelectionIndex = 0;
  let crop = { zoom: 1, x: 0, y: 0, baseScale: 1 };
  let cropByIndex = new Map();
  let pointerState = new Map();
  let dragInfo = null;
  let toastTimer;
  let lastStorageRefresh = 0;

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindEvents();
    registerServiceWorker();
    try {
      db = await openDatabase();
      await repairStoredPosts();
      await loadPosts();
      await requestPersistentStorage();
    } catch (error) {
      console.error('Avvio archivio locale non riuscito:', error);
      loadStaticFallback();
      updateStorageStatus(false);
      showToast('Il feed è visibile, ma il salvataggio locale non è disponibile in questo browser.');
    }
  }

  function bindEvents() {
    els.menuButton.addEventListener('click', openSheet);
    els.backdrop.addEventListener('click', closeSheet);
    $$('[data-close-sheet]').forEach(btn => btn.addEventListener('click', closeSheet));
    els.addButton.addEventListener('click', () => { closeSheet(); beginPhotoSelection(false); });
    els.editButton.addEventListener('click', () => { closeSheet(); setEditMode(true); });
    els.finishEdit.addEventListener('click', () => setEditMode(false));
    els.photoInput.addEventListener('change', onPhotosChosen);
    els.chooseMore.addEventListener('click', () => beginPhotoSelection(true));
    els.setCover.addEventListener('click', setActiveAsCover);
    els.cancelCreate.addEventListener('click', closeCreateModal);
    els.savePost.addEventListener('click', saveNewPost);
    els.zoom.addEventListener('input', () => {
      crop.zoom = Number(els.zoom.value);
      clampCrop();
      renderCrop();
      storeCurrentCrop();
    });
    els.cropStage.addEventListener('pointerdown', onCropPointerDown);
    els.cropStage.addEventListener('pointermove', onCropPointerMove);
    els.cropStage.addEventListener('pointerup', onCropPointerUp);
    els.cropStage.addEventListener('pointercancel', onCropPointerUp);
    els.exportButton.addEventListener('click', exportBackup);
    els.importButton.addEventListener('click', () => { closeSheet(); els.backupInput.click(); });
    els.backupInput.addEventListener('change', importBackup);
    els.resetButton.addEventListener('click', resetInitialFeed);
    els.closeViewer.addEventListener('click', closeViewer);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && editMode) setEditMode(false);
      if (!document.hidden) refreshAfterResume();
    });
    window.addEventListener('pageshow', event => {
      if (event.persisted) refreshAfterResume(true);
    });
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB non disponibile'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const database = req.result;
        let postStore;
        if (!database.objectStoreNames.contains(POSTS_STORE)) {
          postStore = database.createObjectStore(POSTS_STORE, { keyPath: 'id' });
        } else {
          postStore = req.transaction.objectStore(POSTS_STORE);
        }
        if (postStore.indexNames.contains('order')) postStore.deleteIndex('order');
        postStore.createIndex('order', 'order', { unique: false });
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(storeName, mode = 'readonly') {
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function requestToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllPosts() {
    const data = await requestToPromise(tx(POSTS_STORE).getAll());
    return data.sort((a, b) => a.order - b.order);
  }

  async function putPost(post) {
    await requestToPromise(tx(POSTS_STORE, 'readwrite').put(post));
  }

  async function deletePostRecord(id) {
    await requestToPromise(tx(POSTS_STORE, 'readwrite').delete(id));
  }

  async function clearPosts() {
    await requestToPromise(tx(POSTS_STORE, 'readwrite').clear());
  }

  async function getMeta(key) {
    const record = await requestToPromise(tx(META_STORE).get(key));
    return record?.value;
  }

  async function setMeta(key, value) {
    await requestToPromise(tx(META_STORE, 'readwrite').put({ key, value }));
  }

  function initialAssetPath(number) {
    return `./assets/posts/${String(number).padStart(2, '0')}.jpg`;
  }

  function initialEmbeddedUrl(number) {
    const embedded = Array.isArray(window.INITIAL_POST_IMAGES) ? window.INITIAL_POST_IMAGES[number - 1] : null;
    return typeof embedded === 'string' && embedded.startsWith('data:image/') ? embedded : initialAssetPath(number);
  }

  function isImageBlob(value) {
    return value instanceof Blob && value.size > 100 && (!value.type || value.type.startsWith('image/'));
  }

  function isStoredImage(value) {
    return Boolean(value && typeof value === 'object' && typeof value.type === 'string' && (
      value.bytes instanceof ArrayBuffer || ArrayBuffer.isView(value.bytes)
    ));
  }

  function storedImageToBlob(value) {
    if (isImageBlob(value)) return value;
    if (isStoredImage(value)) {
      const bytes = value.bytes instanceof ArrayBuffer
        ? value.bytes
        : value.bytes.buffer.slice(value.bytes.byteOffset, value.bytes.byteOffset + value.bytes.byteLength);
      return new Blob([bytes], { type: value.type || 'image/jpeg' });
    }
    if (typeof value === 'string' && value.startsWith('data:image/')) {
      try { return dataURLToBlob(value); } catch (_) { return null; }
    }
    return null;
  }

  async function imageValueToStored(value) {
    if (isStoredImage(value)) {
      const bytes = value.bytes instanceof ArrayBuffer
        ? value.bytes.slice(0)
        : value.bytes.buffer.slice(value.bytes.byteOffset, value.bytes.byteOffset + value.bytes.byteLength);
      return { type: value.type || 'image/jpeg', bytes };
    }
    const blob = storedImageToBlob(value);
    if (!blob || blob.size <= 100) return null;
    return { type: blob.type || 'image/jpeg', bytes: await blob.arrayBuffer() };
  }

  async function storedImageToDataURL(value) {
    const blob = storedImageToBlob(value);
    if (!blob) return null;
    return blobToDataURL(blob);
  }

  async function blobToStoredImage(blob) {
    if (!isImageBlob(blob)) throw new Error('Immagine non valida');
    return { type: blob.type || 'image/jpeg', bytes: await blob.arrayBuffer() };
  }

  function makeInitialRecord(i) {
    const n = String(i).padStart(2, '0');
    return {
      id: `initial-${n}`,
      order: i - 1,
      createdAt: 1700000000000 - i,
      builtinIndex: i,
      initial: true,
      isCarousel: false,
      coverIndex: 0
    };
  }

  async function seedInitialPosts(force = false) {
    if (force) await clearPosts();
    const existing = await getAllPosts();
    if (existing.length && !force) return;
    for (let i = 1; i <= INITIAL_COUNT; i++) await putPost(makeInitialRecord(i));
    await setMeta('initialized', true);
    await setMeta('dataVersion', DATA_VERSION);
  }

  async function repairStoredPosts() {
    const existing = await getAllPosts();
    const initialized = Boolean(await getMeta('initialized'));

    // Prima apertura (o storage realmente cancellato): crea il feed iniziale.
    // Se invece l'utente ha eliminato volontariamente tutti i post, NON li ricreiamo.
    if (!existing.length) {
      if (!initialized) await seedInitialPosts();
      else await setMeta('dataVersion', DATA_VERSION);
      return;
    }

    for (const post of existing) {
      const initialMatch = /^initial-(\d{2})$/.exec(post?.id || '');
      if (initialMatch) {
        const number = Number(initialMatch[1]);
        if (number < 1 || number > INITIAL_COUNT) continue;
        await putPost({
          ...makeInitialRecord(number),
          order: Number.isFinite(Number(post.order)) ? Number(post.order) : number - 1,
          createdAt: Number(post.createdAt) || (1700000000000 - number)
        });
        continue;
      }

      try {
        const sourceImages = Array.isArray(post.imagesData) && post.imagesData.length
          ? post.imagesData
          : (Array.isArray(post.images) ? post.images : (post.image ? [post.image] : []));
        const imagesData = [];
        for (const value of sourceImages) {
          const normalized = await imageValueToStored(value);
          if (normalized) imagesData.push(normalized);
        }

        let coverDataUrl = typeof post.coverDataUrl === 'string' && post.coverDataUrl.startsWith('data:image/')
          ? post.coverDataUrl
          : null;
        if (!coverDataUrl && post.cover) coverDataUrl = await storedImageToDataURL(post.cover);

        let coverIndex = Math.max(0, Math.min(Number(post.coverIndex) || 0, Math.max(0, imagesData.length - 1)));
        if (!imagesData.length && coverDataUrl) {
          const fromCover = await imageValueToStored(coverDataUrl);
          if (fromCover) imagesData.push(fromCover);
          coverIndex = 0;
        }
        if (!coverDataUrl && imagesData.length) coverDataUrl = await storedImageToDataURL(imagesData[coverIndex] || imagesData[0]);

        if (!imagesData.length || !coverDataUrl) {
          console.warn('Post utente non recuperabile rimosso dalla griglia:', post.id);
          await deletePostRecord(post.id);
          continue;
        }

        await putPost({
          id: String(post.id || `post-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          order: Number.isFinite(Number(post.order)) ? Number(post.order) : 0,
          createdAt: Number(post.createdAt) || Date.now(),
          initial: false,
          isCarousel: imagesData.length > 1,
          coverIndex,
          coverDataUrl,
          imagesData
        });
      } catch (error) {
        console.error('Errore migrazione post', post?.id, error);
      }
    }

    await setMeta('initialized', true);
    await setMeta('dataVersion', DATA_VERSION);
  }

  async function loadPosts() {
    revokePostUrls();
    const stored = await getAllPosts();
    posts = [];

    for (const post of stored) {
      try {
        const initialNumber = Number(post.builtinIndex) || Number(/^initial-(\d{2})$/.exec(post.id || '')?.[1]) || 0;
        if (post.initial && initialNumber >= 1 && initialNumber <= INITIAL_COUNT) {
          const url = initialEmbeddedUrl(initialNumber);
          posts.push({ ...post, builtinIndex: initialNumber, coverUrl: url, imageUrls: [url] });
          continue;
        }

        const images = Array.isArray(post.imagesData) ? post.imagesData : [];
        const imageUrls = images.map(value => {
          const blob = storedImageToBlob(value);
          return blob ? URL.createObjectURL(blob) : null;
        }).filter(Boolean);
        if (!imageUrls.length) continue;

        const coverIndex = Math.max(0, Math.min(Number(post.coverIndex) || 0, imageUrls.length - 1));
        let coverUrl = typeof post.coverDataUrl === 'string' && post.coverDataUrl.startsWith('data:image/')
          ? post.coverDataUrl
          : imageUrls[coverIndex];
        posts.push({ ...post, coverIndex, coverUrl, imageUrls });
      } catch (error) {
        console.error('Post saltato durante il caricamento:', post?.id, error);
      }
    }

    lastStorageRefresh = Date.now();
    renderFeed();
    updateStorageStatus(true);
  }

  function loadStaticFallback() {
    revokePostUrls();
    posts = Array.from({ length: INITIAL_COUNT }, (_, index) => {
      const record = makeInitialRecord(index + 1);
      const url = initialEmbeddedUrl(index + 1);
      return { ...record, coverUrl: url, imageUrls: [url] };
    });
    renderFeed();
  }

  function revokePostUrls() {
    posts.forEach(post => {
      if (post.coverUrl?.startsWith('blob:')) URL.revokeObjectURL(post.coverUrl);
      (post.imageUrls || []).forEach(url => { if (url?.startsWith('blob:')) URL.revokeObjectURL(url); });
    });
  }

  async function refreshAfterResume(force = false) {
    if (!db || !force && Date.now() - lastStorageRefresh < 1200) return;
    if (!els.createModal.hidden || !els.viewer.hidden || editMode) return;
    try {
      await loadPosts();
    } catch (error) {
      console.warn('Ricaricamento archivio dopo riapertura non riuscito:', error);
    }
  }

  function renderFeed() {
    els.grid.classList.toggle('editing', editMode);
    els.grid.innerHTML = '';
    els.empty.hidden = posts.length > 0;
    els.count.textContent = String(posts.length);

    posts.forEach((post, index) => {
      try {
        const item = document.createElement('article');
        item.className = 'feed-item';
        item.dataset.id = String(post.id || `post-${index}`);
        item.dataset.index = String(index);
        item.setAttribute('aria-label', `Post ${index + 1} di ${posts.length}`);

        const image = document.createElement('img');
        image.alt = `Anteprima post ${index + 1}`;
        image.loading = index < 12 ? 'eager' : 'lazy';
        image.decoding = 'auto';
        image.src = post.coverUrl || post.imageUrls?.[post.coverIndex || 0] || post.imageUrls?.[0] || '';
        image.addEventListener('error', () => recoverGridImage(post, image));
        item.append(image);

        if ((post.imageUrls || []).length > 1) {
          const mark = document.createElement('span');
          mark.className = 'carousel-mark';
          mark.setAttribute('aria-label', 'Post con più foto');
          item.append(mark);
        }

        if (editMode) {
          const del = document.createElement('button');
          del.className = 'delete-post';
          del.type = 'button';
          del.setAttribute('aria-label', 'Elimina post');
          del.textContent = '×';
          del.addEventListener('click', event => {
            event.stopPropagation();
            confirmDelete(post.id);
          });
          item.append(del);
          bindLongPressDrag(item);
        } else {
          item.addEventListener('click', () => openViewer(index));
        }
        els.grid.append(item);
      } catch (error) {
        console.error('Errore rendering post', post?.id, error);
      }
    });
  }

  function recoverGridImage(post, image) {
    if (image.dataset.recovery === 'done') return;
    image.dataset.recovery = 'done';
    const initialNumber = Number(post.builtinIndex) || Number(/^initial-(\d{2})$/.exec(post.id || '')?.[1]) || 0;
    if (initialNumber) {
      image.src = initialEmbeddedUrl(initialNumber);
      return;
    }
    const fallback = post.imageUrls?.[post.coverIndex || 0] || post.imageUrls?.[0];
    if (fallback && fallback !== image.src) image.src = fallback;
  }

  function openSheet() {
    els.backdrop.hidden = false;
    els.sheet.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeSheet() {
    els.backdrop.hidden = true;
    els.sheet.hidden = true;
    document.body.style.overflow = '';
  }

  function setEditMode(enabled) {
    editMode = enabled;
    els.editorBar.hidden = !enabled;
    document.body.style.paddingBottom = enabled ? '90px' : '';
    renderFeed();
    if (enabled) showToast('Tieni premuta una foto e trascinala nella nuova posizione');
  }

  function bindLongPressDrag(item) {
    let timer = null;
    let startX = 0;
    let startY = 0;

    const clear = () => { if (timer) clearTimeout(timer); timer = null; };

    item.addEventListener('pointerdown', event => {
      if (event.target.closest('.delete-post')) return;
      startX = event.clientX;
      startY = event.clientY;
      item.setPointerCapture?.(event.pointerId);
      timer = setTimeout(() => startGridDrag(item, event), 260);
    });
    item.addEventListener('pointermove', event => {
      if (dragInfo) {
        updateGridDrag(event);
        return;
      }
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) clear();
    });
    item.addEventListener('pointerup', event => {
      clear();
      if (dragInfo) finishGridDrag(event);
    });
    item.addEventListener('pointercancel', event => {
      clear();
      if (dragInfo) finishGridDrag(event);
    });
  }

  function startGridDrag(item, event) {
    const rect = item.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.innerHTML = `<img src="${$('img', item).src}" alt="">`;
    document.body.append(ghost);
    item.classList.add('drag-source');
    dragInfo = {
      id: item.dataset.id,
      source: item,
      ghost,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    positionGhost(event.clientX, event.clientY);
  }

  function updateGridDrag(event) {
    if (!dragInfo) return;
    event.preventDefault();
    positionGhost(event.clientX, event.clientY);
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.feed-item');
    if (!target || target === dragInfo.source || !els.grid.contains(target)) return;
    const fromIndex = posts.findIndex(p => p.id === dragInfo.id);
    const toId = target.dataset.id;
    const toIndex = posts.findIndex(p => p.id === toId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    const [moved] = posts.splice(fromIndex, 1);
    posts.splice(toIndex, 0, moved);
    els.grid.insertBefore(dragInfo.source, fromIndex < toIndex ? target.nextSibling : target);
  }

  function positionGhost(x, y) {
    dragInfo.ghost.style.left = `${x - dragInfo.offsetX}px`;
    dragInfo.ghost.style.top = `${y - dragInfo.offsetY}px`;
    const edge = 70;
    if (y < edge) window.scrollBy({ top: -12, behavior: 'auto' });
    if (y > window.innerHeight - edge) window.scrollBy({ top: 12, behavior: 'auto' });
  }

  async function finishGridDrag() {
    if (!dragInfo) return;
    dragInfo.source.classList.remove('drag-source');
    dragInfo.ghost.remove();
    dragInfo = null;
    await persistOrder();
    renderFeed();
    showToast('Nuovo ordine salvato');
  }

  async function persistOrder() {
    const transaction = db.transaction(POSTS_STORE, 'readwrite');
    const store = transaction.objectStore(POSTS_STORE);
    posts.forEach((post, order) => {
      post.order = order;
      const clean = stripRuntime(post);
      store.put(clean);
    });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function confirmDelete(id) {
    const ok = window.confirm('Eliminare questo post dall’anteprima?');
    if (!ok) return;
    await deletePostRecord(id);
    await loadPosts();
    if (editMode) renderFeed();
    showToast('Post eliminato');
  }

  function beginPhotoSelection(append) {
    els.photoInput.dataset.append = append ? '1' : '0';
    els.photoInput.value = '';
    els.photoInput.click();
  }

  async function onPhotosChosen(event) {
    const files = [...event.target.files].filter(file => file.type.startsWith('image/'));
    if (!files.length) return;
    const append = event.target.dataset.append === '1';
    if (!append) {
      disposeSelection();
      selection = [];
      activeSelectionIndex = 0;
      coverSelectionIndex = 0;
      cropByIndex.clear();
    }

    showToast('Preparazione delle foto…');
    try {
      for (const file of files) {
        const decoded = await decodeImage(file);
        selection.push({
          file,
          url: decoded.url,
          image: decoded.image,
          name: file.name,
          crop: { zoom: 1, x: 0, y: 0 }
        });
      }
      if (!append) activeSelectionIndex = 0;
      openCreateModal();
      renderSelection();
      activateSelection(activeSelectionIndex);
    } catch (error) {
      console.error(error);
      showToast('Una foto non è stata letta. Prova a salvarla come JPG o PNG.');
    }
  }

  function decodeImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => resolve({ url, image });
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Formato immagine non leggibile')); };
      image.src = url;
    });
  }

  function openCreateModal() {
    els.createModal.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeCreateModal() {
    els.createModal.hidden = true;
    document.body.style.overflow = '';
    disposeSelection();
    selection = [];
    coverSelectionIndex = 0;
    cropByIndex.clear();
  }

  function disposeSelection() {
    selection.forEach(item => item.url && URL.revokeObjectURL(item.url));
  }

  function renderSelection() {
    els.selectedThumbs.innerHTML = '';
    selection.forEach((item, index) => {
      const btn = document.createElement('button');
      btn.className = `selected-thumb${index === activeSelectionIndex ? ' active' : ''}`;
      btn.type = 'button';
      const coverBadge = index === coverSelectionIndex ? '<span class="cover-badge">COPERTINA</span>' : '';
      btn.innerHTML = `<img src="${item.url}" alt="Foto ${index + 1}"><span class="thumb-index">${index + 1}</span>${selection.length > 1 ? '<span class="thumb-remove">×</span>' : ''}${coverBadge}`;
      btn.addEventListener('click', event => {
        if (event.target.closest('.thumb-remove')) {
          event.stopPropagation();
          removeSelected(index);
        } else {
          activateSelection(index);
        }
      });
      els.selectedThumbs.append(btn);
    });
    els.selectedCount.textContent = `${selection.length} ${selection.length === 1 ? 'foto selezionata' : 'foto selezionate'}`;
    els.coverSummary.textContent = `Copertina: foto ${coverSelectionIndex + 1}`;
    const alreadyCover = activeSelectionIndex === coverSelectionIndex;
    els.setCover.disabled = selection.length < 2 || alreadyCover;
    els.setCover.textContent = alreadyCover ? 'Questa foto è la copertina' : `Usa la foto ${activeSelectionIndex + 1} come copertina`;
  }

  function setActiveAsCover() {
    if (!selection.length) return;
    storeCurrentCrop();
    coverSelectionIndex = activeSelectionIndex;
    renderSelection();
    showToast(`Foto ${coverSelectionIndex + 1} impostata come copertina`);
  }

  function removeSelected(index) {
    if (selection.length <= 1) return;
    const [removed] = selection.splice(index, 1);
    URL.revokeObjectURL(removed.url);
    const newMap = new Map();
    [...cropByIndex.entries()].forEach(([key, value]) => {
      if (key < index) newMap.set(key, value);
      if (key > index) newMap.set(key - 1, value);
    });
    cropByIndex = newMap;
    if (coverSelectionIndex === index) coverSelectionIndex = 0;
    else if (coverSelectionIndex > index) coverSelectionIndex -= 1;
    activeSelectionIndex = Math.min(activeSelectionIndex, selection.length - 1);
    renderSelection();
    activateSelection(activeSelectionIndex);
  }

  function activateSelection(index) {
    storeCurrentCrop();
    activeSelectionIndex = index;
    const item = selection[index];
    els.cropImage.src = item.url;
    const saved = cropByIndex.get(index) || item.crop || { zoom: 1, x: 0, y: 0 };
    crop = { ...saved, baseScale: 1 };
    els.cropImage.onload = () => {
      calculateBaseScale();
      clampCrop();
      renderCrop();
    };
    if (els.cropImage.complete) {
      calculateBaseScale();
      clampCrop();
      renderCrop();
    }
    els.zoom.value = String(crop.zoom);
    renderSelection();
  }

  function storeCurrentCrop() {
    if (!selection.length || activeSelectionIndex >= selection.length) return;
    cropByIndex.set(activeSelectionIndex, { zoom: crop.zoom, x: crop.x, y: crop.y });
  }

  function calculateBaseScale() {
    const image = selection[activeSelectionIndex]?.image;
    if (!image) return;
    const rect = els.cropStage.getBoundingClientRect();
    crop.baseScale = Math.max(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  }

  function clampCrop() {
    const image = selection[activeSelectionIndex]?.image;
    if (!image) return;
    const rect = els.cropStage.getBoundingClientRect();
    const scale = crop.baseScale * crop.zoom;
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    const maxX = Math.max(0, (width - rect.width) / 2);
    const maxY = Math.max(0, (height - rect.height) / 2);
    crop.x = Math.max(-maxX, Math.min(maxX, crop.x));
    crop.y = Math.max(-maxY, Math.min(maxY, crop.y));
  }

  function renderCrop() {
    const scale = crop.baseScale * crop.zoom;
    els.cropImage.style.width = `${els.cropImage.naturalWidth}px`;
    els.cropImage.style.height = `${els.cropImage.naturalHeight}px`;
    els.cropImage.style.transform = `translate(-50%, -50%) translate(${crop.x}px, ${crop.y}px) scale(${scale})`;
    els.zoom.value = String(crop.zoom);
  }

  function onCropPointerDown(event) {
    els.cropStage.setPointerCapture?.(event.pointerId);
    pointerState.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointerState.size === 1) {
      crop.dragStart = { x: event.clientX, y: event.clientY, cropX: crop.x, cropY: crop.y };
    } else if (pointerState.size === 2) {
      const points = [...pointerState.values()];
      crop.pinchStart = { distance: distance(points[0], points[1]), zoom: crop.zoom };
    }
  }

  function onCropPointerMove(event) {
    if (!pointerState.has(event.pointerId)) return;
    pointerState.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointerState.size === 1 && crop.dragStart) {
      crop.x = crop.dragStart.cropX + event.clientX - crop.dragStart.x;
      crop.y = crop.dragStart.cropY + event.clientY - crop.dragStart.y;
    } else if (pointerState.size >= 2 && crop.pinchStart) {
      const points = [...pointerState.values()].slice(0, 2);
      const ratio = distance(points[0], points[1]) / Math.max(1, crop.pinchStart.distance);
      crop.zoom = Math.max(1, Math.min(3, crop.pinchStart.zoom * ratio));
    }
    clampCrop();
    renderCrop();
    storeCurrentCrop();
  }

  function onCropPointerUp(event) {
    pointerState.delete(event.pointerId);
    if (pointerState.size === 1) {
      const point = [...pointerState.values()][0];
      crop.dragStart = { x: point.x, y: point.y, cropX: crop.x, cropY: crop.y };
    } else {
      crop.dragStart = null;
      crop.pinchStart = null;
    }
    storeCurrentCrop();
  }

  function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  async function saveNewPost() {
    if (!selection.length) return;
    if (!db) { showToast('Il browser non consente il salvataggio locale.'); return; }
    els.savePost.disabled = true;
    els.savePost.textContent = 'Salvataggio…';
    showToast('Salvataggio del post…');
    try {
      storeCurrentCrop();
      const coverItem = selection[coverSelectionIndex];
      const coverCrop = cropByIndex.get(coverSelectionIndex) || coverItem.crop;
      const coverBlob = await createCoverBlob(coverItem.image, coverCrop);
      const coverDataUrl = await blobToDataURL(coverBlob);
      const imagesData = [];
      for (const item of selection) {
        const compressed = await compressImage(item.image);
        imagesData.push(await blobToStoredImage(compressed));
      }

      const current = await getAllPosts();
      const transaction = db.transaction(POSTS_STORE, 'readwrite');
      const store = transaction.objectStore(POSTS_STORE);
      current.forEach((post, index) => {
        store.put({ ...post, order: index + 1 });
      });
      store.put({
        id: `post-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        order: 0,
        createdAt: Date.now(),
        coverDataUrl,
        imagesData,
        coverIndex: coverSelectionIndex,
        initial: false,
        isCarousel: imagesData.length > 1
      });
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      await setMeta('initialized', true);

      closeCreateModal();
      await loadPosts();
      window.scrollTo({ top: document.querySelector('.profile-tabs').offsetTop, behavior: 'smooth' });
      showToast('Post salvato sul dispositivo');
    } catch (error) {
      console.error(error);
      showToast('Il post non è stato salvato. Controlla lo spazio disponibile.');
    } finally {
      els.savePost.disabled = false;
      els.savePost.textContent = 'Aggiungi';
    }
  }

  function createCoverBlob(image, state) {
    const targetW = 540;
    const targetH = 720;
    const stage = els.cropStage.getBoundingClientRect();
    const frameW = stage.width;
    const frameH = frameW * 4 / 3;
    const baseScale = Math.max(frameW / image.naturalWidth, frameH / image.naturalHeight);
    const scale = baseScale * state.zoom;
    const sourceW = frameW / scale;
    const sourceH = frameH / scale;
    let sourceX = image.naturalWidth / 2 - state.x / scale - sourceW / 2;
    let sourceY = image.naturalHeight / 2 - state.y / scale - sourceH / 2;
    sourceX = Math.max(0, Math.min(image.naturalWidth - sourceW, sourceX));
    sourceY = Math.max(0, Math.min(image.naturalHeight - sourceH, sourceY));
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, targetW, targetH);
    context.drawImage(image, sourceX, sourceY, sourceW, sourceH, 0, 0, targetW, targetH);
    return canvasToBlob(canvas, 'image/jpeg', .82);
  }

  function compressImage(image) {
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvasToBlob(canvas, 'image/jpeg', .82);
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Conversione immagine fallita')), type, quality));
  }

  function stripRuntime(post) {
    const { coverUrl, imageUrls, cover, images, image, assetPath, ...clean } = post;
    return clean;
  }

  async function resetInitialFeed() {
    if (!db) { showToast('Il browser non consente il salvataggio locale.'); return; }
    const ok = window.confirm('Ripristinare i 14 post iniziali? Tutte le modifiche e le foto aggiunte verranno eliminate.');
    if (!ok) return;
    closeSheet();
    await seedInitialPosts(true);
    await loadPosts();
    setEditMode(false);
    showToast('Feed iniziale ripristinato');
  }

  async function exportBackup() {
    if (!db) { closeSheet(); showToast('Nessun archivio locale disponibile da esportare.'); return; }
    closeSheet();
    showToast('Creazione del backup…');
    try {
      const current = await getAllPosts();
      const payload = {
        app: 'Rebecca Feed Planner',
        version: 5,
        exportedAt: new Date().toISOString(),
        posts: []
      };
      for (const post of current) {
        const initialNumber = Number(post.builtinIndex) || Number(/^initial-(\d{2})$/.exec(post.id || '')?.[1]) || 0;
        if (post.initial && initialNumber) {
          const dataUrl = initialEmbeddedUrl(initialNumber);
          payload.posts.push({
            id: post.id,
            order: post.order,
            createdAt: post.createdAt,
            initial: true,
            builtinIndex: initialNumber,
            isCarousel: false,
            coverIndex: 0,
            cover: dataUrl,
            images: [dataUrl]
          });
          continue;
        }

        const imageData = [];
        for (const value of (post.imagesData || [])) {
          const dataUrl = await storedImageToDataURL(value);
          if (dataUrl) imageData.push(dataUrl);
        }
        const coverData = post.coverDataUrl || imageData[Number(post.coverIndex) || 0] || imageData[0] || null;
        if (!imageData.length || !coverData) continue;
        payload.posts.push({
          id: post.id,
          order: post.order,
          createdAt: post.createdAt,
          initial: false,
          isCarousel: imageData.length > 1,
          coverIndex: Number(post.coverIndex) || 0,
          cover: coverData,
          images: imageData
        });
      }
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `backup-feed-rebecca-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      showToast('Backup esportato');
    } catch (error) {
      console.error(error);
      showToast('Backup non riuscito');
    }
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function importBackup(event) {
    if (!db) { showToast('Il browser non consente il salvataggio locale.'); return; }
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (payload.app !== 'Rebecca Feed Planner' || !Array.isArray(payload.posts)) throw new Error('Backup non valido');
      const ok = window.confirm(`Importare ${payload.posts.length} post? Il feed attuale verrà sostituito.`);
      if (!ok) return;
      await clearPosts();
      for (const post of payload.posts) {
        const id = String(post.id || `import-${Date.now()}-${Math.random()}`);
        const initialMatch = /^initial-(\d{2})$/.exec(id);
        if (Boolean(post.initial) && initialMatch) {
          const number = Number(post.builtinIndex) || Number(initialMatch[1]);
          if (number >= 1 && number <= INITIAL_COUNT) {
            await putPost({
              ...makeInitialRecord(number),
              order: Number.isFinite(Number(post.order)) ? Number(post.order) : number - 1,
              createdAt: Number(post.createdAt) || Date.now()
            });
          }
          continue;
        }

        const imageData = Array.isArray(post.images) ? post.images.filter(value => typeof value === 'string' && value.startsWith('data:image/')) : [];
        const imagesData = [];
        for (const value of imageData) {
          const normalized = await imageValueToStored(value);
          if (normalized) imagesData.push(normalized);
        }
        if (!imagesData.length) continue;
        const coverIndex = Math.max(0, Math.min(Number(post.coverIndex) || 0, imagesData.length - 1));
        const coverDataUrl = typeof post.cover === 'string' && post.cover.startsWith('data:image/')
          ? post.cover
          : imageData[coverIndex] || imageData[0];
        await putPost({
          id,
          order: Number.isFinite(Number(post.order)) ? Number(post.order) : 0,
          createdAt: Number(post.createdAt) || Date.now(),
          initial: false,
          isCarousel: imagesData.length > 1,
          coverIndex,
          coverDataUrl,
          imagesData
        });
      }
      await setMeta('initialized', true);
      await setMeta('dataVersion', DATA_VERSION);
      await loadPosts();
      showToast('Backup importato');
    } catch (error) {
      console.error(error);
      showToast('File di backup non valido');
    }
  }

  function dataURLToBlob(dataURL) {
    const [header, body] = dataURL.split(',');
    const mime = header.match(/data:(.*?);base64/)?.[1] || 'image/jpeg';
    const bytes = atob(body);
    const array = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) array[i] = bytes.charCodeAt(i);
    return new Blob([array], { type: mime });
  }

  function openViewer(index) {
    const post = posts[index];
    if (!post) return;
    els.viewerMedia.innerHTML = '';
    els.viewerDots.innerHTML = '';
    const startIndex = Math.max(0, Math.min(Number(post.coverIndex) || 0, post.imageUrls.length - 1));

    post.imageUrls.forEach((url, i) => {
      const slide = document.createElement('div');
      slide.className = 'viewer-slide';
      const image = document.createElement('img');
      image.src = url;
      image.alt = `Foto ${i + 1} del post`;
      image.addEventListener('load', () => {
        slide.dataset.ratio = String(clampViewerRatio(image.naturalWidth / image.naturalHeight));
        if (i === startIndex) setViewerRatio(i);
      });
      slide.append(image);
      els.viewerMedia.append(slide);
      if (post.imageUrls.length > 1) {
        const dot = document.createElement('i');
        if (i === startIndex) dot.className = 'active';
        els.viewerDots.append(dot);
      }
    });

    els.viewer.hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => {
      els.viewerMedia.scrollLeft = startIndex * els.viewerMedia.clientWidth;
      setViewerRatio(startIndex);
    });
    els.viewerMedia.onscroll = () => {
      const active = Math.round(els.viewerMedia.scrollLeft / Math.max(1, els.viewerMedia.clientWidth));
      $$('#viewerDots i').forEach((dot, i) => dot.classList.toggle('active', i === active));
      setViewerRatio(active);
    };
  }

  function clampViewerRatio(ratio) {
    if (!Number.isFinite(ratio) || ratio <= 0) return 1;
    return Math.max(.75, Math.min(1.91, ratio));
  }

  function setViewerRatio(index) {
    const slide = els.viewerMedia.children[index];
    if (!slide) return;
    const image = $('img', slide);
    const ratio = Number(slide.dataset.ratio) || (image?.naturalWidth ? clampViewerRatio(image.naturalWidth / image.naturalHeight) : 1);
    const width = els.viewerMedia.clientWidth || window.innerWidth;
    els.viewerMedia.style.height = `${Math.round(width / ratio)}px`;
  }

  function closeViewer() {
    els.viewer.hidden = true;
    document.body.style.overflow = '';
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add('show');
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  async function requestPersistentStorage() {
    try {
      if (!navigator.storage) {
        updateStorageStatus(true, false);
        return;
      }
      let persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (!persisted && navigator.storage.persist) persisted = await navigator.storage.persist();
      updateStorageStatus(true, persisted);
    } catch (_) {
      updateStorageStatus(true, false);
    }
  }

  async function updateStorageStatus(working, persistent = null) {
    if (!els.storageStatus) return;
    if (!working) {
      els.storageStatus.textContent = 'Memoria locale non disponibile';
      els.storageStatus.dataset.state = 'error';
      return;
    }
    let detail = `${posts.length} post salvati`;
    try {
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        if (Number.isFinite(estimate.usage)) detail += ` · ${Math.max(1, Math.round(estimate.usage / 1048576))} MB usati`;
      }
    } catch (_) {}
    els.storageStatus.textContent = persistent === true
      ? `Salvataggio verificato · ${detail} · memoria persistente`
      : `Salvataggio verificato su questo iPhone · ${detail}`;
    els.storageStatus.dataset.state = 'ok';
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('./sw.js?v=5', { updateViaCache: 'none' })
        .then(registration => registration.update().catch(() => {}))
        .catch(error => console.warn('Service worker:', error));
    }
  }
})();
