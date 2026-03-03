const CART_KEY = 'aopc_cart';
const waveformCache = new Map();
let sharedAudioContext;
let currentPreviewAudio = null;
let currentPreviewButton = null;
let currentPreviewState = null;

function getCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_err) {
    return [];
  }
}

function setCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

function updateCartCount() {
  const count = getCart().length;
  document.querySelectorAll('[data-cart-count]').forEach((el) => {
    el.textContent = `(${count})`;
  });
}

function getAudioContext() {
  if (!sharedAudioContext) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    sharedAudioContext = AudioCtx ? new AudioCtx() : null;
  }
  return sharedAudioContext;
}

async function getWavePeaks(audioUrl, samples = 170) {
  if (!audioUrl) return null;
  const cached = waveformCache.get(audioUrl);
  if (cached) return cached;

  const context = getAudioContext();
  if (!context) return null;

  try {
    const response = await fetch(audioUrl);
    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0);
    const blockSize = Math.max(1, Math.floor(channelData.length / samples));
    const peaks = new Array(samples).fill(0);

    let maxPeak = 0;
    for (let i = 0; i < samples; i += 1) {
      const start = i * blockSize;
      const end = Math.min(start + blockSize, channelData.length);
      let peak = 0;

      for (let j = start; j < end; j += 1) {
        const value = Math.abs(channelData[j]);
        if (value > peak) peak = value;
      }

      peaks[i] = peak;
      if (peak > maxPeak) maxPeak = peak;
    }

    const normalized = peaks.map((peak) => {
      if (maxPeak === 0) return 0.02;
      return Math.max(0.02, Math.min(1, peak / maxPeak));
    });

    waveformCache.set(audioUrl, normalized);
    return normalized;
  } catch (_err) {
    return null;
  }
}

function buildSyntheticWavePath(index, points = 160) {
  const width = 1000;
  const mid = 50;
  const xStep = width / (points - 1);
  const topPoints = [];

  for (let i = 0; i < points; i += 1) {
    const n1 = Math.abs(Math.sin((index + 2) * 0.67 + i * 0.14));
    const n2 = Math.abs(Math.cos((index + 3) * 0.31 + i * 0.08));
    const n3 = Math.abs(Math.sin((index + 5) * 0.19 + i * 0.035));
    const envelope = 0.4 + Math.abs(Math.sin(i * 0.018 + index)) * 0.85;
    const amp = Math.max(2.2, (n1 * 0.44 + n2 * 0.33 + n3 * 0.23) * 43 * envelope);

    topPoints.push({
      x: Number((i * xStep).toFixed(2)),
      y: Number((mid - amp * 0.5).toFixed(2))
    });
  }

  let d = `M 0 ${mid.toFixed(2)} `;
  topPoints.forEach((point) => {
    d += `L ${point.x} ${point.y} `;
  });

  for (let i = topPoints.length - 1; i >= 0; i -= 1) {
    const point = topPoints[i];
    const mirroredY = Number((mid + (mid - point.y)).toFixed(2));
    d += `L ${point.x} ${mirroredY} `;
  }

  d += 'Z';
  return d;
}

function buildWavePathFromPeaks(peaks) {
  const width = 1000;
  const mid = 50;
  const xStep = width / (peaks.length - 1);
  let d = `M 0 ${mid.toFixed(2)} `;

  peaks.forEach((peak, i) => {
    const x = Number((i * xStep).toFixed(2));
    const y = Number((mid - peak * 42).toFixed(2));
    d += `L ${x} ${y} `;
  });

  for (let i = peaks.length - 1; i >= 0; i -= 1) {
    const x = Number((i * xStep).toFixed(2));
    const mirroredY = Number((mid + peaks[i] * 42).toFixed(2));
    d += `L ${x} ${mirroredY} `;
  }

  d += 'Z';
  return d;
}

function buildWaveSvg(index, _isActive, peaks = null) {
  const basePath = peaks ? buildWavePathFromPeaks(peaks) : buildSyntheticWavePath(index, 170);

  return `
    <svg class="wave-svg" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
      <path class="wave-shape" d="${basePath}"></path>
      <path class="wave-shape-progress" d="${basePath}"></path>
    </svg>
    <span class="wave-head" aria-hidden="true"></span>
  `;
}

async function renderIndexPage() {
  const latestList = document.getElementById('latest-list');
  const collectionsGrid = document.getElementById('collections-grid');
  if (!latestList || !collectionsGrid) return;

  const featured = packs.filter((pack) => pack.featured).slice(0, 6);
  const waveformTasks = [];
  const previewStates = new Map();

  const setWaveProgress = (state, progressPercent) => {
    const clamped = Math.max(0, Math.min(100, progressPercent));
    state.waveTrack.style.setProperty('--progress', `${clamped}%`);
  };

  const setPreviewButtonState = (button, isPlaying) => {
    const icon = button.querySelector('span');
    if (icon) icon.textContent = isPlaying ? '❚❚' : '▶';
    button.classList.toggle('is-playing', isPlaying);
  };

  const pauseCurrentPreview = () => {
    if (!currentPreviewAudio || !currentPreviewState) return;
    currentPreviewAudio.pause();
    setPreviewButtonState(currentPreviewState.button, false);
    currentPreviewState.row.classList.remove('is-playing');
  };

  const ensurePreviewAudio = (state) => {
    if (state.audio || !state.audioSrc) return state.audio;

    const audio = new Audio(state.audioSrc);
    audio.preload = 'metadata';

    audio.addEventListener('loadedmetadata', () => {
      if (typeof state.pendingSeek === 'number' && audio.duration) {
        audio.currentTime = audio.duration * state.pendingSeek;
        state.pendingSeek = null;
      }
      const progress = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
      setWaveProgress(state, progress);
    });

    audio.addEventListener('timeupdate', () => {
      if (!audio.duration) return;
      setWaveProgress(state, (audio.currentTime / audio.duration) * 100);
    });

    audio.addEventListener('play', () => {
      state.row.classList.add('is-playing');
      setPreviewButtonState(state.button, true);
    });

    audio.addEventListener('pause', () => {
      state.row.classList.remove('is-playing');
      setPreviewButtonState(state.button, false);
    });

    audio.addEventListener('ended', () => {
      setWaveProgress(state, 0);
      if (currentPreviewState === state) {
        currentPreviewAudio = null;
        currentPreviewButton = null;
        currentPreviewState = null;
      }
    });

    state.audio = audio;
    return audio;
  };

  featured.forEach((pack, index) => {
    const row = document.createElement('div');
    row.className = `latest-row reveal ${index === 1 ? 'is-active' : ''}`;
    row.dataset.previewId = String(index);

    row.innerHTML = `
      <span class="mini-art" style="background-image:url('${pack.artwork}')"></span>
      <button class="preview-toggle" type="button" data-audio="${pack.previewAudio || ''}" aria-label="Play ${pack.title}" title="Play ${pack.title}">
        <span aria-hidden="true">▶</span>
      </button>
      <span class="wave-track" data-wave-track>
        ${buildWaveSvg(index, index === 1)}
      </span>
    `;

    latestList.appendChild(row);

    const state = {
      row,
      button: row.querySelector('.preview-toggle'),
      waveTrack: row.querySelector('[data-wave-track]'),
      audioSrc: pack.previewAudio || '',
      audio: null,
      pendingSeek: null
    };
    setWaveProgress(state, 0);
    previewStates.set(row.dataset.previewId, state);

    if (pack.previewAudio) {
      waveformTasks.push(
        getWavePeaks(pack.previewAudio).then((peaks) => {
          if (!state.waveTrack || !peaks) return;
          state.waveTrack.innerHTML = buildWaveSvg(index, index === 1, peaks);
          setWaveProgress(state, state.audio && state.audio.duration ? (state.audio.currentTime / state.audio.duration) * 100 : 0);
        })
      );
    }
  });

  latestList.addEventListener('click', (event) => {
    const button = event.target.closest('.preview-toggle');
    if (button) {
      const row = button.closest('.latest-row');
      if (!row) return;
      const state = previewStates.get(row.dataset.previewId);
      if (!state || !state.audioSrc) return;

      const audio = ensurePreviewAudio(state);
      if (!audio) return;

      if (currentPreviewState && currentPreviewState !== state) {
        pauseCurrentPreview();
      }

      currentPreviewAudio = audio;
      currentPreviewButton = button;
      currentPreviewState = state;

      if (!audio.paused) {
        audio.pause();
      } else {
        audio.play().catch(() => {});
      }
      return;
    }

    const waveTrack = event.target.closest('[data-wave-track]');
    if (!waveTrack) return;
    const row = waveTrack.closest('.latest-row');
    if (!row) return;
    const state = previewStates.get(row.dataset.previewId);
    if (!state || !state.audioSrc) return;

    const audio = ensurePreviewAudio(state);
    if (!audio) return;

    if (currentPreviewState && currentPreviewState !== state) {
      pauseCurrentPreview();
    }

    const rect = waveTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));

    if (audio.duration && Number.isFinite(audio.duration)) {
      audio.currentTime = audio.duration * ratio;
      setWaveProgress(state, ratio * 100);
    } else {
      state.pendingSeek = ratio;
    }

    currentPreviewAudio = audio;
    currentPreviewButton = state.button;
    currentPreviewState = state;
    audio.play().catch(() => {});
  });

  packs.forEach((pack, index) => {
    const card = document.createElement('article');
    card.className = 'collection-card reveal';
    card.style.transitionDelay = `${Math.min(index * 55, 350)}ms`;

    card.innerHTML = `
      <a class="collection-media-link" href="record-template.html?pack=${encodeURIComponent(pack.title)}" aria-label="Open ${pack.title}">
        <div class="artwork-placeholder">
          <img src="${pack.artwork}" alt="${pack.title} artwork" loading="lazy" />
        </div>
      </a>
      <a class="collection-title-link" href="record-template.html?pack=${encodeURIComponent(pack.title)}" aria-label="Open ${pack.title}">
        <h3>${pack.title}</h3>
      </a>
      <p class="collection-price">FROM $20</p>
      <button class="ghost-btn collection-add-btn" type="button" data-pack-title="${pack.title}">ADD TO CART</button>
    `;

    collectionsGrid.appendChild(card);
  });

  collectionsGrid.addEventListener('click', (event) => {
    const button = event.target.closest('.collection-add-btn');
    if (!button) return;

    const title = button.getAttribute('data-pack-title');
    if (!title) return;

    const cart = getCart();
    cart.push({
      title,
      option: 'Compositions',
      price: 20,
      addedAt: Date.now()
    });
    setCart(cart);
    updateCartCount();

    button.textContent = 'ADDED';
    setTimeout(() => {
      button.textContent = 'ADD TO CART';
    }, 1000);
  });

  if (waveformTasks.length) {
    await Promise.all(waveformTasks);
  }
}

function renderRecordPage() {
  const titleEl = document.getElementById('record-title');
  if (!titleEl) return;

  const params = new URLSearchParams(window.location.search);
  const packName = params.get('pack');
  const pack = packs.find((item) => item.title === packName) || packs[0];

  titleEl.textContent = pack.title;
  const descriptionEl = document.getElementById('pack-description');
  if (descriptionEl) {
    descriptionEl.textContent =
      pack.description ||
      'A carefully curated set of original recordings designed for producers, editors, and composers. This collection balances character-rich instrumentation with clean arrangement space so you can sample, chop, and layer quickly across different styles.';
  }

  const addCartButton = document.getElementById('add-cart');
  const selectedPriceEl = document.getElementById('selected-price');
  const optionButtons = document.querySelectorAll('.purchase-option');
  const recordArtwork = document.getElementById('record-artwork');
  if (recordArtwork) {
    recordArtwork.innerHTML = `<img src="${pack.artwork}" alt="${pack.title} artwork" loading="eager" />`;
  }

  const pricing = {
    compositions: { label: 'Compositions', amount: 20 },
    stems: { label: 'Compositions & Stems', amount: 40 }
  };

  let selectedKey = 'compositions';
  const syncPurchaseState = () => {
    const selected = pricing[selectedKey];
    if (selectedPriceEl) selectedPriceEl.textContent = `$${selected.amount}`;

    optionButtons.forEach((button) => {
      const isSelected = button.getAttribute('data-option') === selectedKey;
      button.classList.toggle('is-active', isSelected);
      button.setAttribute('aria-pressed', String(isSelected));
    });
  };

  optionButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const option = button.getAttribute('data-option');
      if (!option || !pricing[option]) return;
      selectedKey = option;
      syncPurchaseState();
    });
  });
  syncPurchaseState();

  addCartButton.addEventListener('click', () => {
    const cart = getCart();
    const selected = pricing[selectedKey];
    cart.push({
      title: pack.title,
      option: selected.label,
      price: selected.amount,
      addedAt: Date.now()
    });
    setCart(cart);
    updateCartCount();
    addCartButton.textContent = 'ADDED';
    setTimeout(() => {
      addCartButton.textContent = 'ADD TO CART';
    }, 1200);
  });
}

function initReveal() {
  const elements = document.querySelectorAll('.reveal');
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 }
  );

  elements.forEach((el) => observer.observe(el));
}

document.addEventListener('DOMContentLoaded', () => {
  updateCartCount();
  renderIndexPage();
  renderRecordPage();
  initReveal();
});
