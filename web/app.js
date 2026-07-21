'use strict';

// PUBLIC_PATH is injected by the server as window.PUBLIC_PATH (e.g. "/dnd").
// It is the prefix the browser must include in all API URLs so the reverse
// proxy can route them correctly. Falls back to "" (no prefix).
const BASE_PATH = (typeof window.PUBLIC_PATH === 'string') ? window.PUBLIC_PATH : '';

/* ═══════════════════════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════════════════════ */
const state = {
  campaigns: [],
  sessions: {},          // campaignID → [sessions]
  currentCampaign: null,
  currentSession: null,
  tracks: [],            // SessionTrack[] for currentSession
  activeTags: new Set(), // currently-active session filter tags

  // Central library
  libraryTracks: [],         // LibraryTrack[] — full library
  activeLibraryTags: new Set(), // filter tags for library view
  libraryPickerAdded: new Set(), // libraryTrack IDs already in current session

  // Player
  queue: [],             // [{track, sessionName}]
  queueIndex: -1,
  isPlaying: false,
  isLooping: false,
  isCrossfade: false,
  crossfadeSecs: 3,
  volume: 0.8,
  isMuted: false,
  prevVolume: 0.8,

  // Layered simultaneous tracks
  layeredTracks: [],     // [{track, audio, volume}]

  // Soundboard
  soundboardSounds: [],      // SoundboardSound[]
  activeSoundInstances: [],  // [{instanceId, soundId, audio}] — one-shot overlays currently playing
  editingSoundId: null,

  // Crossfade internals
  _crossfadeTimer: null,
  _fadingOut: false,
  _nextAudio: null,

  // Modal state
  editingCampaignId: null,
  editingSessionId:  null,
  editingSessionCampaignId: null,
  confirmCallback: null,

  // Tag input state (upload + edit modals)
  uploadTags: [],
  editTags: [],
};

/* ═══════════════════════════════════════════════════════════════════════════════
   AUDIO ENGINE
   ═══════════════════════════════════════════════════════════════════════════════ */
const audio = new Audio();
audio.preload = 'metadata';

audio.addEventListener('ended', () => {
  if (state.isLooping) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } else {
    advanceQueue();
  }
});

audio.addEventListener('play',  () => { state.isPlaying = true;  updatePlayBtn(); });
audio.addEventListener('pause', () => { state.isPlaying = false; updatePlayBtn(); });

audio.addEventListener('timeupdate', () => {
  updateProgress();

  if (!state.isCrossfade || state._fadingOut) return;
  const remaining = audio.duration - audio.currentTime;
  if (audio.duration > 0 && remaining <= state.crossfadeSecs && state.queue.length > 1) {
    startCrossfade();
  }
});

function audioSrc(filename) {
  return `${BASE_PATH}/api/audio/${encodeURIComponent(filename)}`;
}

function playTrackFromQueue(index) {
  if (index < 0 || index >= state.queue.length) return;
  state.queueIndex = index;
  const { track, sessionName } = state.queue[index];

  cancelCrossfade();

  audio.src = audioSrc(track.filename);
  audio.volume = state.isMuted ? 0 : state.volume;
  audio.play().catch(err => showToast('Playback error: ' + err.message, 'error'));

  state.isPlaying = true;
  updateNowPlaying(track.name, sessionName);
  updatePlayBtn();
  updateQueueCount();
  highlightPlayingCard();
  if (document.getElementById('queue-panel').classList.contains('open')) {
    renderQueuePanel();
  }
}

function advanceQueue() {
  cancelCrossfade();
  state._fadingOut = false;

  if (state.queue.length === 0) {
    stopPlayer();
    return;
  }

  const next = state.queueIndex + 1;
  if (next < state.queue.length) {
    playTrackFromQueue(next);
  } else {
    // End of queue
    stopPlayer();
  }
}

function stopPlayer() {
  audio.pause();
  audio.src = '';
  state.isPlaying = false;
  state.queueIndex = -1;
  updatePlayBtn();
  updateNowPlaying('No track playing', '');
  resetProgress();
  highlightPlayingCard();
  cancelCrossfade();
}

/* ── Crossfade ────────────────────────────────────────────────────────────── */
function startCrossfade() {
  if (state._fadingOut) return;
  const nextIndex = state.queueIndex + 1;
  if (nextIndex >= state.queue.length) return;

  state._fadingOut = true;
  const fadeSecs   = state.crossfadeSecs * 1000;
  const steps      = 40;
  const interval   = fadeSecs / steps;
  const volStep    = (state.isMuted ? 0 : state.volume) / steps;

  // Pre-load next track on a shadow Audio element
  const { track, sessionName } = state.queue[nextIndex];
  const nextAudio = new Audio(audioSrc(track.filename));
  nextAudio.volume = 0;
  nextAudio.play().catch(() => {});
  state._nextAudio = nextAudio;

  let step = 0;
  state._crossfadeTimer = setInterval(() => {
    step++;
    const mainVol = Math.max(0, (state.isMuted ? 0 : state.volume) - volStep * step);
    const fadeVol = Math.min(state.isMuted ? 0 : state.volume, volStep * step);
    audio.volume = mainVol;
    nextAudio.volume = fadeVol;

    if (step >= steps) {
      clearInterval(state._crossfadeTimer);
      state._crossfadeTimer = null;

      // Swap: kill old audio, make nextAudio the main player
      audio.pause();
      audio.src = '';

      // We have to manually swap – Audio element can't be replaced in-place
      // so we advance the queue and let the 'ended' handler trigger,
      // but since we already started next audio we just track state.
      state.queueIndex = nextIndex;
      state._fadingOut = false;

      // Re-assign src on main audio to keep timeupdate logic working
      audio.src = nextAudio.src;
      audio.volume = state.isMuted ? 0 : state.volume;
      // Sync position from nextAudio
      audio.currentTime = nextAudio.currentTime;
      audio.play().catch(() => {});
      nextAudio.pause();
      nextAudio.src = '';
      state._nextAudio = null;

      updateNowPlaying(track.name, sessionName);
      updateQueueCount();
      highlightPlayingCard();
    }
  }, interval);
}

function cancelCrossfade() {
  if (state._crossfadeTimer) {
    clearInterval(state._crossfadeTimer);
    state._crossfadeTimer = null;
  }
  state._fadingOut = false;
  if (state._nextAudio) {
    state._nextAudio.pause();
    state._nextAudio.src = '';
    state._nextAudio = null;
  }
  audio.volume = state.isMuted ? 0 : state.volume;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   API HELPERS
   ═══════════════════════════════════════════════════════════════════════════════ */
async function apiFetch(method, path, body) {
  const opts = {
    method,
    headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
  };
  if (body) {
    opts.body = body instanceof FormData ? body : JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const api = {
  // Campaigns
  getCampaigns:   ()           => apiFetch('GET',    `${BASE_PATH}/api/campaigns`),
  createCampaign: (name, desc) => apiFetch('POST',   `${BASE_PATH}/api/campaigns`,    { name, description: desc }),
  updateCampaign: (id, n, d)   => apiFetch('PUT',    `${BASE_PATH}/api/campaigns/${id}`, { name: n, description: d }),
  deleteCampaign: (id)         => apiFetch('DELETE', `${BASE_PATH}/api/campaigns/${id}`),

  // Sessions
  getSessions:    (cid)        => apiFetch('GET',    `${BASE_PATH}/api/campaigns/${cid}/sessions`),
  createSession:  (cid, n, d)  => apiFetch('POST',   `${BASE_PATH}/api/campaigns/${cid}/sessions`, { name: n, description: d }),
  updateSession:  (id, n, d)   => apiFetch('PUT',    `${BASE_PATH}/api/sessions/${id}`, { name: n, description: d }),
  deleteSession:  (id)         => apiFetch('DELETE', `${BASE_PATH}/api/sessions/${id}`),

  // Session playlist
  getSessionTracks:      (sid)              => apiFetch('GET',    `${BASE_PATH}/api/sessions/${sid}/tracks`),
  addTrackToSession:     (sid, libId)       => apiFetch('POST',   `${BASE_PATH}/api/sessions/${sid}/tracks`, { library_track_id: libId }),
  removeTrackFromSession:(sid, stId)        => apiFetch('DELETE', `${BASE_PATH}/api/sessions/${sid}/tracks/${stId}`),
  reorderSessionTracks:  (sid, ids)         => apiFetch('PUT',    `${BASE_PATH}/api/sessions/${sid}/tracks/reorder`, { ids }),

  // Library
  getLibraryTracks:   ()           => apiFetch('GET',    `${BASE_PATH}/api/library`),
  updateLibraryTrack: (id, n, tags)=> apiFetch('PUT',    `${BASE_PATH}/api/library/${id}`, { name: n, tags }),
  deleteLibraryTrack: (id)         => apiFetch('DELETE', `${BASE_PATH}/api/library/${id}`),

  uploadLibraryTrack: (formData) =>
    fetch(`${BASE_PATH}/api/library`, { method: 'POST', body: formData })
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
      }),

  // Soundboard
  getSoundboardSounds:   ()        => apiFetch('GET',    `${BASE_PATH}/api/soundboard`),
  updateSoundboardSound: (id, n)   => apiFetch('PUT',    `${BASE_PATH}/api/soundboard/${id}`, { name: n }),
  deleteSoundboardSound: (id)      => apiFetch('DELETE', `${BASE_PATH}/api/soundboard/${id}`),

  uploadSoundboardSound: (formData) =>
    fetch(`${BASE_PATH}/api/soundboard`, { method: 'POST', body: formData })
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
      }),
};

/* ═══════════════════════════════════════════════════════════════════════════════
   TAG COLOUR PALETTE
   ═══════════════════════════════════════════════════════════════════════════════ */
const tagColorCache = {};
let tagColorCounter = 0;
const TAG_COLOR_COUNT = 8;

function tagColor(name) {
  if (!(name in tagColorCache)) {
    tagColorCache[name] = tagColorCounter % TAG_COLOR_COUNT;
    tagColorCounter++;
  }
  return tagColorCache[name];
}

function tagBadgeHTML(name) {
  return `<span class="track-tag tag-color-${tagColor(name)}">${escapeHTML(name)}</span>`;
}

function filterPillHTML(name, active) {
  return `<span class="tag-filter-pill${active ? ' active' : ''}" data-tag="${escapeHTML(name)}">${escapeHTML(name)}</span>`;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   SIDEBAR RENDERING
   ═══════════════════════════════════════════════════════════════════════════════ */
async function loadCampaigns() {
  try {
    state.campaigns = await api.getCampaigns();
  } catch (e) {
    showToast('Failed to load campaigns: ' + e.message, 'error');
    state.campaigns = [];
  }
  renderSidebar();
}

function renderSidebar() {
  const tree = document.getElementById('campaign-tree');

  if (state.campaigns.length === 0) {
    tree.innerHTML = `<div class="sidebar-empty">No campaigns yet.<br/>Click <strong>+ Campaign</strong> to begin.</div>`;
    return;
  }

  tree.innerHTML = state.campaigns.map(c => renderCampaignItem(c)).join('');

  // Restore open/active state
  state.campaigns.forEach(c => {
    const sessions = state.sessions[c.id];
    if (sessions) {
      const el = document.getElementById(`campaign-item-${c.id}`);
      if (el) el.classList.add('open');
      renderSessionList(c.id, sessions);
    }
  });

  attachSidebarEvents();
}

function renderCampaignItem(c) {
  return `
    <div class="campaign-item" id="campaign-item-${c.id}">
      <div class="campaign-header" data-campaign-id="${c.id}">
        <span class="campaign-toggle">&#9658;</span>
        <span class="campaign-name">${escapeHTML(c.name)}</span>
        <div class="item-actions">
          <button class="item-action-btn" data-action="edit-campaign" data-id="${c.id}" title="Edit campaign">&#9998;</button>
          <button class="item-action-btn danger" data-action="delete-campaign" data-id="${c.id}" title="Delete campaign">&times;</button>
        </div>
      </div>
      <div class="session-list" id="session-list-${c.id}">
        <div class="session-list-inner" id="session-list-inner-${c.id}">
          <!-- sessions injected here -->
        </div>
        <button class="btn-add-session" data-campaign-id="${c.id}">&#43; Add Session</button>
      </div>
    </div>`;
}

function renderSessionList(campaignId, sessions) {
  const inner = document.getElementById(`session-list-inner-${campaignId}`);
  if (!inner) return;

  inner.innerHTML = sessions.map(s => `
    <div class="session-item${state.currentSession && state.currentSession.id === s.id ? ' active' : ''}"
         data-session-id="${s.id}" data-campaign-id="${campaignId}">
      <span class="session-dot"></span>
      <span class="session-name">${escapeHTML(s.name)}</span>
      <div class="item-actions">
        <button class="item-action-btn" data-action="edit-session" data-id="${s.id}" data-campaign-id="${campaignId}" title="Edit session">&#9998;</button>
        <button class="item-action-btn danger" data-action="delete-session" data-id="${s.id}" title="Delete session">&times;</button>
      </div>
    </div>`).join('');
}

function attachSidebarEvents() {
  const tree = document.getElementById('campaign-tree');

  // Campaign header toggle / session click delegation
  tree.querySelectorAll('.campaign-header').forEach(header => {
    header.addEventListener('click', e => {
      // Don't toggle if clicking action buttons
      if (e.target.closest('.item-actions')) return;
      const cid = parseInt(header.dataset.campaignId);
      toggleCampaign(cid);
    });
  });

  tree.querySelectorAll('[data-action="edit-campaign"]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      openEditCampaignModal(id);
    });
  });

  tree.querySelectorAll('[data-action="delete-campaign"]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      const c = state.campaigns.find(x => x.id === id);
      confirmDelete(
        `Delete campaign "${c ? c.name : id}"? All sessions and tracks will be permanently removed.`,
        async () => {
          await api.deleteCampaign(id);
          // If current session was under this campaign, clear it
          if (state.currentSession) {
            const sessions = state.sessions[id] || [];
            if (sessions.find(s => s.id === state.currentSession.id)) {
              clearSessionView();
            }
          }
          delete state.sessions[id];
          await loadCampaigns();
          showToast('Campaign deleted', 'info');
        }
      );
    });
  });

  tree.querySelectorAll('[data-action="edit-session"]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openEditSessionModal(parseInt(btn.dataset.id), parseInt(btn.dataset.campaignId));
    });
  });

  tree.querySelectorAll('[data-action="delete-session"]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const sid = parseInt(btn.dataset.id);
      const cid = parseInt(btn.dataset.campaignId);
      const sessions = state.sessions[cid] || [];
      const s = sessions.find(x => x.id === sid);
      confirmDelete(
        `Delete session "${s ? s.name : sid}"? All tracks will be permanently removed.`,
        async () => {
          await api.deleteSession(sid);
          if (state.currentSession && state.currentSession.id === sid) clearSessionView();
          state.sessions[cid] = (state.sessions[cid] || []).filter(x => x.id !== sid);
          renderSessionList(cid, state.sessions[cid]);
          showToast('Session deleted', 'info');
        }
      );
    });
  });

  tree.querySelectorAll('[data-action], .session-item').forEach(el => {});

  // Session item click (select session)
  tree.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.item-actions')) return;
      const sid = parseInt(item.dataset.sessionId);
      const cid = parseInt(item.dataset.campaignId);
      selectSession(sid, cid);
    });
  });

  // Add session buttons
  tree.querySelectorAll('.btn-add-session').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openAddSessionModal(parseInt(btn.dataset.campaignId));
    });
  });
}

async function toggleCampaign(cid) {
  const item = document.getElementById(`campaign-item-${cid}`);
  if (!item) return;

  const isOpen = item.classList.contains('open');

  if (isOpen) {
    item.classList.remove('open');
    return;
  }

  item.classList.add('open');

  // Load sessions if not cached
  if (!state.sessions[cid]) {
    try {
      state.sessions[cid] = await api.getSessions(cid);
    } catch (e) {
      showToast('Failed to load sessions: ' + e.message, 'error');
      state.sessions[cid] = [];
    }
  }
  renderSessionList(cid, state.sessions[cid]);
  attachSidebarEvents();
}

async function selectSession(sessionId, campaignId) {
  // On tablet, close the sidebar after selecting a session
  if (isTablet()) closeSidebar();

  // Find session object
  const sessions = state.sessions[campaignId] || [];
  const session  = sessions.find(s => s.id === sessionId);
  if (!session) return;

  const campaign = state.campaigns.find(c => c.id === campaignId);

  state.currentSession  = session;
  state.currentCampaign = campaign || null;
  state.activeTags.clear();

  // Switch sidebar tab back to Campaigns if Library was active
  document.querySelectorAll('.sidebar-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === 'campaigns');
  });

  // Update active class in sidebar
  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.sessionId) === sessionId);
  });

  // Show session view, hide others
  document.getElementById('main-empty').style.display    = 'none';
  document.getElementById('library-view').style.display  = 'none';
  document.getElementById('session-view').style.display  = 'flex';
  document.getElementById('session-title').textContent   = session.name;
  document.getElementById('session-campaign-name').textContent = campaign ? campaign.name : '';

  await loadTracks(sessionId);
}

function clearSessionView() {
  state.currentSession  = null;
  state.currentCampaign = null;
  state.tracks = [];
  document.getElementById('main-empty').style.display   = '';
  document.getElementById('session-view').style.display = 'none';
  document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   TRACK LIST RENDERING
   ═══════════════════════════════════════════════════════════════════════════════ */
async function loadTracks(sessionId) {
  try {
    state.tracks = await api.getSessionTracks(sessionId);
  } catch (e) {
    showToast('Failed to load tracks: ' + e.message, 'error');
    state.tracks = [];
  }
  renderTracks();
  renderTagFilterBar();
}

// state.tracks is SessionTrack[]; each has .id (sessionTrackId), .position, .track (LibraryTrack)
function visibleTracks() {
  if (state.activeTags.size === 0) return state.tracks;
  return state.tracks.filter(st =>
    [...state.activeTags].every(tag => st.track.tags.includes(tag))
  );
}

// ── drag-and-drop state for session track reorder ────────────────────────────
let _stDragSrcIndex = null;

function renderTracks() {
  const list  = document.getElementById('track-list');
  const empty = document.getElementById('tracks-empty');
  const visible = visibleTracks();

  list.querySelectorAll('.track-card').forEach(el => el.remove());

  if (visible.length === 0) {
    empty.style.display = '';
    empty.textContent = state.activeTags.size > 0
      ? 'No tracks match the selected tags.'
      : 'No tracks in this session yet. Click "Add from Library" to add tracks.';
    return;
  }

  empty.style.display = 'none';

  const playingTrack = currentlyPlayingTrack();

  visible.forEach((st, idx) => {
    const track     = st.track;           // LibraryTrack
    const isPlaying = playingTrack && playingTrack.id === track.id;

    const card = document.createElement('div');
    card.className = `track-card${isPlaying ? ' playing' : ''}`;
    card.dataset.trackId       = track.id;
    card.dataset.sessionTrackId = st.id;
    card.dataset.index         = idx;
    card.draggable             = true;

    const playIcon = isPlaying
      ? `<div class="eq-bars"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>`
      : '&#9654;';

    card.innerHTML = `
      <span class="track-drag-handle" title="Drag to reorder">&#8942;&#8942;</span>
      <button class="track-play-btn" title="Play now">${playIcon}</button>
      <div class="track-info">
        <div class="track-name">${escapeHTML(track.name)}</div>
        <div class="track-tags">${track.tags.map(tagBadgeHTML).join('')}</div>
      </div>
      <div class="track-actions">
        <button class="track-btn queue" title="Add to queue">&#43; Queue</button>
        <button class="track-btn layer" title="Layer (simultaneous playback)">&#127911; Layer</button>
        <button class="track-btn edit"  title="Edit in library">&#9998;</button>
        <button class="track-btn delete" title="Remove from session">&times;</button>
      </div>`;

    card.querySelector('.track-play-btn').addEventListener('click', () => {
      playTrackImmediately(track);
    });
    card.querySelector('.track-btn.queue').addEventListener('click', () => {
      addToQueue(track);
    });
    card.querySelector('.track-btn.layer').addEventListener('click', () => {
      addLayer(track);
    });
    card.querySelector('.track-btn.edit').addEventListener('click', () => {
      openEditTrackModal(track);
    });
    card.querySelector('.track-btn.delete').addEventListener('click', () => {
      confirmDelete(
        `Remove "${track.name}" from this session? The track stays in the library.`,
        async () => {
          await api.removeTrackFromSession(state.currentSession.id, st.id);
          state.queue = state.queue.filter(q => q.track.id !== track.id);
          updateQueueCount();
          await loadTracks(state.currentSession.id);
          showToast(`"${track.name}" removed from session`, 'info');
        }
      );
    });

    // ── Drag-to-reorder ────────────────────────────────────────────────
    card.addEventListener('dragstart', e => {
      _stDragSrcIndex = idx;
      card.classList.add('dragging-track');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging-track');
      list.querySelectorAll('.track-card').forEach(c => c.classList.remove('drag-over-track'));
      _stDragSrcIndex = null;
    });
    card.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      list.querySelectorAll('.track-card').forEach(c => c.classList.remove('drag-over-track'));
      card.classList.add('drag-over-track');
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over-track');
    });
    card.addEventListener('drop', e => {
      e.preventDefault();
      card.classList.remove('drag-over-track');
      const destIdx = parseInt(card.dataset.index);
      if (_stDragSrcIndex !== null && _stDragSrcIndex !== destIdx) {
        sessionTrackMove(_stDragSrcIndex, destIdx);
      }
    });

    list.appendChild(card);
  });
}

async function sessionTrackMove(fromIdx, toIdx) {
  // Reorder locally for instant feedback
  const item = state.tracks.splice(fromIdx, 1)[0];
  state.tracks.splice(toIdx, 0, item);
  renderTracks();

  // Persist new order to server
  try {
    await api.reorderSessionTracks(
      state.currentSession.id,
      state.tracks.map(st => st.id)
    );
  } catch (e) {
    showToast('Failed to save order: ' + e.message, 'error');
    // Re-fetch to get back to consistent state
    await loadTracks(state.currentSession.id);
  }
}

function renderTagFilterBar() {
  const bar   = document.getElementById('tag-filter-bar');
  const pills = document.getElementById('tag-filter-pills');
  const clear = document.getElementById('btn-clear-filter');

  const allTags = [...new Set(state.tracks.flatMap(st => st.track.tags))].sort();

  if (allTags.length === 0) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';
  pills.innerHTML = allTags.map(t => filterPillHTML(t, state.activeTags.has(t))).join('');
  clear.style.display = state.activeTags.size > 0 ? '' : 'none';

  pills.querySelectorAll('.tag-filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const tag = pill.dataset.tag;
      if (state.activeTags.has(tag)) state.activeTags.delete(tag);
      else state.activeTags.add(tag);
      renderTracks();
      renderTagFilterBar();
    });
  });
}

function highlightPlayingCard() {
  const playing = currentlyPlayingTrack();
  document.querySelectorAll('.track-card').forEach(card => {
    const trackId  = parseInt(card.dataset.trackId);
    const isPlaying = playing && playing.id === trackId;
    card.classList.toggle('playing', isPlaying);
    const playBtn = card.querySelector('.track-play-btn');
    if (playBtn) {
      playBtn.innerHTML = isPlaying
        ? `<div class="eq-bars"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>`
        : '&#9654;';
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   LIBRARY VIEW
   ═══════════════════════════════════════════════════════════════════════════════ */
async function loadLibrary() {
  try {
    state.libraryTracks = await api.getLibraryTracks();
  } catch (e) {
    showToast('Failed to load library: ' + e.message, 'error');
    state.libraryTracks = [];
  }
  renderLibrary();
  renderLibraryTagFilterBar();
}

function visibleLibraryTracks() {
  if (state.activeLibraryTags.size === 0) return state.libraryTracks;
  return state.libraryTracks.filter(t =>
    [...state.activeLibraryTags].every(tag => t.tags.includes(tag))
  );
}

function renderLibrary() {
  const list  = document.getElementById('library-track-list');
  const empty = document.getElementById('library-tracks-empty');
  const tracks = visibleLibraryTracks();

  list.querySelectorAll('.track-card').forEach(el => el.remove());

  if (tracks.length === 0) {
    empty.style.display = '';
    empty.textContent = state.activeLibraryTags.size > 0
      ? 'No tracks match the selected tags.'
      : 'No tracks in the library yet. Upload your first track!';
    return;
  }

  empty.style.display = 'none';

  const playingTrack = currentlyPlayingTrack();

  tracks.forEach(track => {
    const isPlaying = playingTrack && playingTrack.id === track.id;
    const card = document.createElement('div');
    card.className = `track-card${isPlaying ? ' playing' : ''}`;
    card.dataset.trackId = track.id;

    const playIcon = isPlaying
      ? `<div class="eq-bars"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>`
      : '&#9654;';

    card.innerHTML = `
      <button class="track-play-btn" title="Play now">${playIcon}</button>
      <div class="track-info">
        <div class="track-name">${escapeHTML(track.name)}</div>
        <div class="track-tags">${track.tags.map(tagBadgeHTML).join('')}</div>
      </div>
      <div class="track-actions">
        <button class="track-btn queue" title="Add to queue">&#43; Queue</button>
        <button class="track-btn layer" title="Layer (simultaneous playback)">&#127911; Layer</button>
        <button class="track-btn edit"  title="Edit track">&#9998;</button>
        <button class="track-btn delete" title="Delete from library">&times;</button>
      </div>`;

    card.querySelector('.track-play-btn').addEventListener('click', () => {
      playTrackImmediately(track);
    });
    card.querySelector('.track-btn.queue').addEventListener('click', () => {
      addToQueue(track);
    });
    card.querySelector('.track-btn.layer').addEventListener('click', () => {
      addLayer(track);
    });
    card.querySelector('.track-btn.edit').addEventListener('click', () => {
      openEditTrackModal(track);
    });
    card.querySelector('.track-btn.delete').addEventListener('click', () => {
      confirmDelete(
        `Delete "${track.name}" from the library? It will be removed from all sessions and the audio file will be permanently deleted.`,
        async () => {
          await api.deleteLibraryTrack(track.id);
          state.queue = state.queue.filter(q => q.track.id !== track.id);
          updateQueueCount();
          await loadLibrary();
          showToast('Track deleted from library', 'info');
        }
      );
    });

    list.appendChild(card);
  });
}

function renderLibraryTagFilterBar() {
  const bar   = document.getElementById('library-tag-filter-bar');
  const pills = document.getElementById('library-tag-filter-pills');
  const clear = document.getElementById('btn-clear-library-filter');

  const allTags = [...new Set(state.libraryTracks.flatMap(t => t.tags))].sort();

  if (allTags.length === 0) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';
  pills.innerHTML = allTags.map(t => filterPillHTML(t, state.activeLibraryTags.has(t))).join('');
  clear.style.display = state.activeLibraryTags.size > 0 ? '' : 'none';

  pills.querySelectorAll('.tag-filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const tag = pill.dataset.tag;
      if (state.activeLibraryTags.has(tag)) state.activeLibraryTags.delete(tag);
      else state.activeLibraryTags.add(tag);
      renderLibrary();
      renderLibraryTagFilterBar();
    });
  });
}

function showLibraryView() {
  document.getElementById('main-empty').style.display    = 'none';
  document.getElementById('session-view').style.display  = 'none';
  document.getElementById('library-view').style.display  = 'flex';
  document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  state.currentSession  = null;
  state.currentCampaign = null;
  loadLibrary();
}

/* ═══════════════════════════════════════════════════════════════════════════════
   SOUNDBOARD
   ═══════════════════════════════════════════════════════════════════════════════ */
async function loadSoundboard() {
  try {
    state.soundboardSounds = await api.getSoundboardSounds();
  } catch (e) {
    showToast('Failed to load soundboard: ' + e.message, 'error');
    state.soundboardSounds = [];
  }
  renderSoundboard();
}

function renderSoundboard() {
  const grid  = document.getElementById('soundboard-grid');
  const empty = document.getElementById('soundboard-empty');

  grid.querySelectorAll('.sound-tile').forEach(el => el.remove());

  if (state.soundboardSounds.length === 0) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  state.soundboardSounds.forEach(sound => {
    const isActive = state.activeSoundInstances.some(s => s.soundId === sound.id);
    const tile = document.createElement('div');
    tile.className = `sound-tile${isActive ? ' playing' : ''}`;
    tile.dataset.soundId = sound.id;

    tile.innerHTML = `
      <button class="sound-tile-play" title="Play &quot;${escapeHTML(sound.name)}&quot;">
        <span class="sound-tile-icon">&#127908;</span>
        <span class="sound-tile-name">${escapeHTML(sound.name)}</span>
      </button>
      <div class="sound-tile-actions">
        <button class="track-btn edit" title="Rename sound">&#9998;</button>
        <button class="track-btn delete" title="Delete sound">&times;</button>
      </div>`;

    tile.querySelector('.sound-tile-play').addEventListener('click', () => {
      playSoundboardSound(sound);
    });
    tile.querySelector('.track-btn.edit').addEventListener('click', () => {
      openEditSoundModal(sound);
    });
    tile.querySelector('.track-btn.delete').addEventListener('click', () => {
      confirmDelete(
        `Delete "${sound.name}" from the soundboard? The audio file will be permanently deleted.`,
        async () => {
          await api.deleteSoundboardSound(sound.id);
          await loadSoundboard();
          showToast('Sound deleted', 'info');
        }
      );
    });

    grid.appendChild(tile);
  });
}

function showSoundboardView() {
  document.getElementById('main-empty').style.display      = 'none';
  document.getElementById('session-view').style.display    = 'none';
  document.getElementById('library-view').style.display    = 'none';
  document.getElementById('soundboard-view').style.display = 'flex';
  document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  state.currentSession  = null;
  state.currentCampaign = null;
  loadSoundboard();
}

// One-shot, fire-and-forget playback: clicking a sound overlays a new
// instance on top of whatever else is playing. Clicking again while it's
// still playing starts another overlapping instance.
function playSoundboardSound(sound) {
  const instanceId = `${sound.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const soundAudio = new Audio(audioSrc(sound.filename));
  soundAudio.loop   = false;
  soundAudio.volume = state.isMuted ? 0 : state.volume;

  const instance = { instanceId, soundId: sound.id, audio: soundAudio };
  state.activeSoundInstances.push(instance);
  highlightSoundTile(sound.id, true);

  const cleanup = () => {
    state.activeSoundInstances = state.activeSoundInstances.filter(s => s.instanceId !== instanceId);
    if (!state.activeSoundInstances.some(s => s.soundId === sound.id)) {
      highlightSoundTile(sound.id, false);
    }
  };
  soundAudio.addEventListener('ended', cleanup);
  soundAudio.addEventListener('error', cleanup);

  soundAudio.play().catch(err => {
    showToast('Playback error: ' + err.message, 'error');
    cleanup();
  });
}

function highlightSoundTile(soundId, isActive) {
  const tile = document.querySelector(`.sound-tile[data-sound-id="${soundId}"]`);
  if (tile) tile.classList.toggle('playing', isActive);
}

function stopAllSoundboardSounds() {
  if (state.activeSoundInstances.length === 0) return;
  state.activeSoundInstances.forEach(s => {
    s.audio.pause();
    s.audio.src = '';
  });
  state.activeSoundInstances = [];
  document.querySelectorAll('.sound-tile.playing').forEach(el => el.classList.remove('playing'));
  showToast('All sounds stopped', 'info');
}

function currentlyPlayingTrack() {
  if (state.queueIndex >= 0 && state.queueIndex < state.queue.length) {
    return state.queue[state.queueIndex].track;
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   PLAYER CONTROLS
   ═══════════════════════════════════════════════════════════════════════════════ */
function playTrackImmediately(track) {
  const sessionName = state.currentSession ? state.currentSession.name : 'Library';
  // Clear queue and replace with this single track (or restart from it if already queued)
  const existingIndex = state.queue.findIndex(q => q.track.id === track.id);
  if (existingIndex >= 0) {
    playTrackFromQueue(existingIndex);
    return;
  }
  // Otherwise start a fresh queue from just this track
  state.queue = [{ track, sessionName }];
  state.queueIndex = 0;
  playTrackFromQueue(0);
}

function addToQueue(track) {
  const sessionName = state.currentSession ? state.currentSession.name : 'Library';
  state.queue.push({ track, sessionName });
  updateQueueCount();
  showToast(`"${track.name}" added to queue`, 'success');

  // Auto-start if nothing is playing
  if (!state.isPlaying) {
    playTrackFromQueue(state.queue.length - 1);
  } else if (document.getElementById('queue-panel').classList.contains('open')) {
    renderQueuePanel();
  }
}

function addLayer(track) {
  // Don't duplicate
  if (state.layeredTracks.find(l => l.track.id === track.id)) {
    showToast(`"${track.name}" is already layered`, 'info');
    return;
  }

  const layerAudio = new Audio(audioSrc(track.filename));
  layerAudio.loop   = true;
  layerAudio.volume = state.isMuted ? 0 : state.volume;
  layerAudio.play().catch(err => showToast('Layer playback error: ' + err.message, 'error'));

  state.layeredTracks.push({ track, audio: layerAudio, volume: state.volume });
  renderLayerItems();
  showToast(`Layering "${track.name}"`, 'info');
}

function removeLayer(trackId) {
  const idx = state.layeredTracks.findIndex(l => l.track.id === trackId);
  if (idx === -1) return;
  const layer = state.layeredTracks[idx];
  layer.audio.pause();
  layer.audio.src = '';
  state.layeredTracks.splice(idx, 1);
  renderLayerItems();
}

function renderLayerItems() {
  const container = document.getElementById('player-layers');
  container.innerHTML = state.layeredTracks.map(layer => `
    <div class="layer-item" data-layer-id="${layer.track.id}">
      <span class="layer-name" title="${escapeHTML(layer.track.name)}">${escapeHTML(layer.track.name)}</span>
      <input type="range" class="layer-volume" min="0" max="1" step="0.01"
             value="${layer.volume}" data-layer-id="${layer.track.id}" title="Layer volume" />
      <button class="layer-stop-btn" data-layer-id="${layer.track.id}" title="Stop layer">&times;</button>
    </div>`).join('');

  container.querySelectorAll('.layer-volume').forEach(slider => {
    slider.addEventListener('input', () => {
      const lid = parseInt(slider.dataset.layerId);
      const layer = state.layeredTracks.find(l => l.track.id === lid);
      if (layer) {
        layer.volume = parseFloat(slider.value);
        layer.audio.volume = state.isMuted ? 0 : layer.volume;
      }
    });
  });

  container.querySelectorAll('.layer-stop-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      removeLayer(parseInt(btn.dataset.layerId));
    });
  });
}

function updateNowPlaying(trackName, sessionName) {
  document.getElementById('player-track-name').textContent    = trackName;
  document.getElementById('player-track-session').textContent = sessionName;
}

function updatePlayBtn() {
  const btn = document.getElementById('btn-play-pause');
  btn.innerHTML = state.isPlaying ? '&#9646;&#9646;' : '&#9654;';
  btn.title     = state.isPlaying ? 'Pause' : 'Play';
}

function formatTime(secs) {
  if (!isFinite(secs) || isNaN(secs)) return '--:--';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateProgress() {
  const elapsed  = audio.currentTime  || 0;
  const duration = audio.duration     || 0;
  const pct      = duration > 0 ? (elapsed / duration) * 100 : 0;

  document.getElementById('player-progress-bar').style.width = pct + '%';
  document.getElementById('player-time').innerHTML = duration > 0
    ? `<span class="player-time-elapsed">${formatTime(elapsed)}</span>
       <span class="player-time-sep">/</span>
       <span class="player-time-total">${formatTime(duration)}</span>`
    : '';
}

function resetProgress() {
  document.getElementById('player-progress-bar').style.width = '0%';
  document.getElementById('player-time').innerHTML = '';
}

function initProgressBar() {
  const wrap = document.getElementById('player-progress-wrap');

  wrap.addEventListener('click', e => {
    if (!audio.duration) return;
    const rect = wrap.getBoundingClientRect();
    const pct  = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * audio.duration;
    updateProgress();
  });

  // Touch seek for iPad
  wrap.addEventListener('touchmove', e => {
    if (!audio.duration) return;
    e.preventDefault();
    const rect  = wrap.getBoundingClientRect();
    const touch = e.touches[0];
    const pct   = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
    audio.currentTime = pct * audio.duration;
    updateProgress();
  }, { passive: false });
}

function updateQueueCount() {
  const remaining = Math.max(0, state.queue.length - state.queueIndex - 1);
  document.getElementById('queue-count').textContent =
    remaining === 1 ? '1 in queue' : `${remaining} in queue`;
  // Keep the open-queue button highlighted when there are tracks
  document.getElementById('btn-open-queue').classList.toggle('active',
    state.queue.length > 0 && document.getElementById('queue-panel').classList.contains('open'));
}

function setVolume(v) {
  state.volume = v;
  state.isMuted = (v === 0);
  audio.volume  = v;
  state.layeredTracks.forEach(l => { l.audio.volume = l.volume * v; });
  state.activeSoundInstances.forEach(s => { s.audio.volume = v; });
  updateVolIcon();
}

/* ═══════════════════════════════════════════════════════════════════════════════
   QUEUE PANEL
   ═══════════════════════════════════════════════════════════════════════════════ */

function openQueuePanel() {
  document.getElementById('queue-panel').classList.add('open');
  document.getElementById('queue-panel-overlay').classList.add('visible');
  document.getElementById('btn-open-queue').classList.add('active');
  renderQueuePanel();
}

function closeQueuePanel() {
  document.getElementById('queue-panel').classList.remove('open');
  document.getElementById('queue-panel-overlay').classList.remove('visible');
  document.getElementById('btn-open-queue').classList.remove('active');
}

function toggleQueuePanel() {
  if (document.getElementById('queue-panel').classList.contains('open')) {
    closeQueuePanel();
  } else {
    openQueuePanel();
  }
}

function renderQueuePanel() {
  const list  = document.getElementById('queue-list');
  const empty = document.getElementById('queue-empty');

  if (state.queue.length === 0) {
    empty.style.display = 'block';
    list.innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = state.queue.map((item, idx) => {
    const playing  = idx === state.queueIndex;
    const isFirst  = idx === 0;
    const isLast   = idx === state.queue.length - 1;

    return `
      <li class="queue-item${playing ? ' is-playing' : ''}"
          draggable="true"
          data-index="${idx}">
        <span class="queue-drag-handle" title="Drag to reorder">&#8942;&#8942;</span>
        <div class="queue-item-indicator">
          ${playing
            ? `<span class="eq-bars"><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span></span>`
            : `<span class="queue-item-num">${idx + 1}</span>`}
        </div>
        <div class="queue-item-info">
          <div class="queue-item-name" title="${escapeHTML(item.track.name)}">${escapeHTML(item.track.name)}</div>
          <div class="queue-item-session">${escapeHTML(item.sessionName)}</div>
        </div>
        <div class="queue-item-controls">
          <button class="queue-ctrl-btn" data-action="up"   data-index="${idx}" title="Move up"   ${isFirst  ? 'disabled' : ''}>&#9650;</button>
          <button class="queue-ctrl-btn" data-action="down" data-index="${idx}" title="Move down" ${isLast   ? 'disabled' : ''}>&#9660;</button>
          <button class="queue-ctrl-btn remove"             data-action="remove" data-index="${idx}" title="Remove">&#10005;</button>
        </div>
      </li>`;
  }).join('');

  attachQueuePanelEvents();
}

// ── Drag-and-drop state ───────────────────────────────────────────────────────
let _dragSrcIndex = null;

function attachQueuePanelEvents() {
  const list = document.getElementById('queue-list');

  // Up / Down / Remove buttons
  list.querySelectorAll('.queue-ctrl-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx    = parseInt(btn.dataset.index);
      const action = btn.dataset.action;
      if      (action === 'up')     queueMoveUp(idx);
      else if (action === 'down')   queueMoveDown(idx);
      else if (action === 'remove') queueRemove(idx);
    });
  });

  // Click track name to jump to it
  list.querySelectorAll('.queue-item-info').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.closest('.queue-item').dataset.index);
      playTrackFromQueue(idx);
      renderQueuePanel();
    });
  });

  // Drag-and-drop reorder
  list.querySelectorAll('.queue-item').forEach(item => {
    item.addEventListener('dragstart', e => {
      _dragSrcIndex = parseInt(item.dataset.index);
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.queue-item').forEach(i => i.classList.remove('drag-over'));
      _dragSrcIndex = null;
    });

    item.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      list.querySelectorAll('.queue-item').forEach(i => i.classList.remove('drag-over'));
      item.classList.add('drag-over');
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });

    item.addEventListener('drop', e => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const destIndex = parseInt(item.dataset.index);
      if (_dragSrcIndex !== null && _dragSrcIndex !== destIndex) {
        queueMove(_dragSrcIndex, destIndex);
      }
    });
  });
}

// ── Queue mutation helpers ────────────────────────────────────────────────────

function queueMove(fromIdx, toIdx) {
  const item = state.queue.splice(fromIdx, 1)[0];
  state.queue.splice(toIdx, 0, item);

  // Keep queueIndex pointing at the same track
  if (state.queueIndex === fromIdx) {
    state.queueIndex = toIdx;
  } else if (fromIdx < state.queueIndex && toIdx >= state.queueIndex) {
    state.queueIndex--;
  } else if (fromIdx > state.queueIndex && toIdx <= state.queueIndex) {
    state.queueIndex++;
  }

  updateQueueCount();
  renderQueuePanel();
}

function queueMoveUp(idx) {
  if (idx <= 0) return;
  queueMove(idx, idx - 1);
}

function queueMoveDown(idx) {
  if (idx >= state.queue.length - 1) return;
  queueMove(idx, idx + 1);
}

function queueRemove(idx) {
  const wasPlaying = idx === state.queueIndex;
  const wasLast    = idx === state.queue.length - 1;

  state.queue.splice(idx, 1);

  if (wasPlaying) {
    // If we just removed the currently playing track, play the next one
    // (which is now at the same index), or stop if the queue is now empty.
    if (state.queue.length === 0) {
      stopPlayer();
    } else {
      const nextIdx = Math.min(idx, state.queue.length - 1);
      state.queueIndex = nextIdx - 1; // playTrackFromQueue will increment via advanceQueue
      playTrackFromQueue(nextIdx);
    }
  } else if (idx < state.queueIndex) {
    // Removed a track before the current one — shift index back
    state.queueIndex--;
  }
  // If idx > queueIndex (removed a later track), queueIndex stays the same.

  updateQueueCount();
  renderQueuePanel();
  highlightPlayingCard();
}

function queueClear() {
  stopPlayer();
  state.queue = [];
  state.queueIndex = -1;
  updateQueueCount();
  renderQueuePanel();
  highlightPlayingCard();
}

function updateVolIcon() {
  const icon = document.getElementById('vol-icon');
  if (state.isMuted || state.volume === 0) {
    icon.textContent = '🔇';
  } else if (state.volume < 0.4) {
    icon.textContent = '🔉';
  } else {
    icon.textContent = '🔊';
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   MODAL HELPERS
   ═══════════════════════════════════════════════════════════════════════════════ */
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function confirmDelete(message, callback) {
  document.getElementById('confirm-message').textContent = message;
  state.confirmCallback = callback;
  openModal('modal-confirm');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   CAMPAIGN MODAL
   ═══════════════════════════════════════════════════════════════════════════════ */
function openAddCampaignModal() {
  state.editingCampaignId = null;
  document.getElementById('campaign-modal-title').textContent = 'New Campaign';
  document.getElementById('campaign-name-input').value = '';
  document.getElementById('campaign-desc-input').value = '';
  openModal('modal-campaign');
  setTimeout(() => document.getElementById('campaign-name-input').focus(), 80);
}

function openEditCampaignModal(id) {
  const c = state.campaigns.find(x => x.id === id);
  if (!c) return;
  state.editingCampaignId = id;
  document.getElementById('campaign-modal-title').textContent = 'Edit Campaign';
  document.getElementById('campaign-name-input').value = c.name;
  document.getElementById('campaign-desc-input').value = c.description || '';
  openModal('modal-campaign');
  setTimeout(() => document.getElementById('campaign-name-input').focus(), 80);
}

async function saveCampaign() {
  const name = document.getElementById('campaign-name-input').value.trim();
  const desc = document.getElementById('campaign-desc-input').value.trim();
  if (!name) { showToast('Campaign name is required', 'error'); return; }

  const btn = document.getElementById('btn-save-campaign');
  btn.disabled = true;

  try {
    if (state.editingCampaignId) {
      await api.updateCampaign(state.editingCampaignId, name, desc);
      showToast('Campaign updated', 'success');
    } else {
      await api.createCampaign(name, desc);
      showToast('Campaign created', 'success');
    }
    closeModal('modal-campaign');
    await loadCampaigns();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   SESSION MODAL
   ═══════════════════════════════════════════════════════════════════════════════ */
function openAddSessionModal(campaignId) {
  state.editingSessionId         = null;
  state.editingSessionCampaignId = campaignId;
  document.getElementById('session-modal-title').textContent = 'New Session';
  document.getElementById('session-name-input').value = '';
  document.getElementById('session-desc-input').value = '';
  openModal('modal-session');
  setTimeout(() => document.getElementById('session-name-input').focus(), 80);
}

function openEditSessionModal(sessionId, campaignId) {
  const sessions = state.sessions[campaignId] || [];
  const s = sessions.find(x => x.id === sessionId);
  if (!s) return;

  state.editingSessionId         = sessionId;
  state.editingSessionCampaignId = campaignId;
  document.getElementById('session-modal-title').textContent = 'Edit Session';
  document.getElementById('session-name-input').value = s.name;
  document.getElementById('session-desc-input').value = s.description || '';
  openModal('modal-session');
  setTimeout(() => document.getElementById('session-name-input').focus(), 80);
}

async function saveSession() {
  const name = document.getElementById('session-name-input').value.trim();
  const desc = document.getElementById('session-desc-input').value.trim();
  if (!name) { showToast('Session name is required', 'error'); return; }

  const btn = document.getElementById('btn-save-session');
  btn.disabled = true;

  try {
    const cid = state.editingSessionCampaignId;

    if (state.editingSessionId) {
      const updated = await api.updateSession(state.editingSessionId, name, desc);
      // Update cache
      if (state.sessions[cid]) {
        const idx = state.sessions[cid].findIndex(s => s.id === state.editingSessionId);
        if (idx >= 0) state.sessions[cid][idx] = updated;
      }
      // Update UI if this is the current session
      if (state.currentSession && state.currentSession.id === state.editingSessionId) {
        state.currentSession = updated;
        document.getElementById('session-title').textContent = updated.name;
      }
      showToast('Session updated', 'success');
    } else {
      const created = await api.createSession(cid, name, desc);
      if (!state.sessions[cid]) state.sessions[cid] = [];
      state.sessions[cid].push(created);
      showToast('Session created', 'success');
    }

    closeModal('modal-session');
    renderSessionList(cid, state.sessions[cid] || []);
    attachSidebarEvents();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   UPLOAD TRACK MODAL
   ═══════════════════════════════════════════════════════════════════════════════ */
let uploadFiles = [];

function openUploadModal() {
  uploadFiles = [];
  state.uploadTags = [];
  document.getElementById('upload-name-input').value = '';
  document.getElementById('upload-file-input').value = '';
  document.getElementById('file-drop-text').innerHTML = 'Drop audio files here or <span class="file-browse-link">browse</span>';
  document.getElementById('file-drop-zone').classList.remove('has-file', 'dragover');
  document.getElementById('upload-progress-wrap').style.display = 'none';
  document.getElementById('upload-progress-bar').style.width    = '0%';
  document.getElementById('upload-name-row').style.display = '';
  renderTagPills('upload');
  openModal('modal-upload');
  setTimeout(() => document.getElementById('upload-name-input').focus(), 80);
}

async function saveUpload() {
  if (!uploadFiles.length) { showToast('Please select an audio file', 'error'); return; }

  const isSingle = uploadFiles.length === 1;
  const name = document.getElementById('upload-name-input').value.trim();
  if (isSingle && !name) { showToast('Track name is required', 'error'); return; }

  const btn = document.getElementById('btn-save-upload');
  btn.disabled = true;

  const progressWrap = document.getElementById('upload-progress-wrap');
  const progressBar  = document.getElementById('upload-progress-bar');
  const progressText = document.getElementById('upload-progress-text');
  progressWrap.style.display = '';
  progressBar.style.width    = '0%';

  try {
    if (isSingle) {
      progressText.textContent = 'Uploading…';

      const fd = new FormData();
      fd.append('file', uploadFiles[0]);
      fd.append('name', name);
      fd.append('tags', state.uploadTags.join(','));

      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${BASE_PATH}/api/library`);

        xhr.upload.addEventListener('progress', e => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            progressBar.style.width  = pct + '%';
            progressText.textContent = `Uploading… ${pct}%`;
          }
        });

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch {
              console.error('Upload: server returned non-JSON on success. Status:', xhr.status);
              console.error('Upload: raw response body:', xhr.responseText);
              console.error('Upload: response headers:', xhr.getAllResponseHeaders());
              reject(new Error(
                `Server returned invalid JSON after upload (status ${xhr.status}). ` +
                `Raw response: ${xhr.responseText.substring(0, 300)}`
              ));
            }
          } else {
            let msg = `HTTP ${xhr.status}`;
            try {
              const parsed = JSON.parse(xhr.responseText);
              msg = parsed.error || msg;
            } catch {
              if (xhr.responseText) msg = `HTTP ${xhr.status}: ${xhr.responseText.substring(0, 200)}`;
            }
            console.error('Upload failed:', xhr.status, xhr.responseText);
            reject(new Error(msg));
          }
        });

        xhr.addEventListener('error', () => {
          console.error('Upload network error');
          reject(new Error('Network error — check your connection or proxy configuration'));
        });
        xhr.addEventListener('abort', () => {
          console.error('Upload aborted');
          reject(new Error('Upload was aborted — the server or proxy may have closed the connection (check size limits or timeouts)'));
        });
        xhr.addEventListener('timeout', () => {
          console.error('Upload timed out');
          reject(new Error('Upload timed out'));
        });

        xhr.send(fd);
      });

      progressBar.style.width  = '100%';
      progressText.textContent = 'Upload complete!';
      await loadLibrary();
      showToast(`"${name}" uploaded to library`, 'success');
      setTimeout(() => closeModal('modal-upload'), 600);
    } else {
      const total = uploadFiles.length;
      const tags  = state.uploadTags.join(',');
      let done = 0;
      progressText.textContent = `0 / ${total} uploaded`;

      const results = [];
      for (let i = 0; i < uploadFiles.length; i += 5) {
        const batch = uploadFiles.slice(i, i + 5);
        const batchResults = await Promise.all(batch.map(file => {
          const trackName = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
          const fd = new FormData();
          fd.append('file', file);
          fd.append('name', trackName);
          fd.append('tags', tags);
          return fetch(`${BASE_PATH}/api/library`, { method: 'POST', body: fd })
            .then(res => {
              if (!res.ok) return res.json().then(j => { throw new Error(j.error || `HTTP ${res.status}`); });
              return res.json();
            })
            .then(() => ({ ok: true }))
            .catch(e => ({ ok: false, error: e.message }))
            .then(result => {
              done++;
              progressBar.style.width  = Math.round(done / total * 100) + '%';
              progressText.textContent = `${done} / ${total} uploaded`;
              return result;
            });
        }));
        results.push(...batchResults);
      }

      await loadLibrary();
      const succeeded = results.filter(r => r.ok).length;
      const failedCount = total - succeeded;

      if (failedCount === 0) {
        showToast(`${total} track${total !== 1 ? 's' : ''} uploaded to library`, 'success');
        setTimeout(() => closeModal('modal-upload'), 600);
      } else if (succeeded === 0) {
        showToast(`All ${total} uploads failed`, 'error');
        progressWrap.style.display = 'none';
      } else {
        showToast(`${succeeded} of ${total} uploaded — ${failedCount} failed`, 'error');
        setTimeout(() => closeModal('modal-upload'), 1200);
      }
    }
  } catch (e) {
    showToast('Upload failed: ' + e.message, 'error');
    progressWrap.style.display = 'none';
  } finally {
    btn.disabled = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   EDIT TRACK MODAL
   ═══════════════════════════════════════════════════════════════════════════════ */
function openEditTrackModal(track) {
  state.editTags = [...(track.tags || [])];
  document.getElementById('edit-track-id').value          = track.id;
  document.getElementById('edit-track-name-input').value  = track.name;
  renderTagPills('edit');
  openModal('modal-edit-track');
  setTimeout(() => document.getElementById('edit-track-name-input').focus(), 80);
}

async function saveEditTrack() {
  const id   = parseInt(document.getElementById('edit-track-id').value);
  const name = document.getElementById('edit-track-name-input').value.trim();
  if (!name) { showToast('Track name is required', 'error'); return; }

  const btn = document.getElementById('btn-save-edit-track');
  btn.disabled = true;

  try {
    await api.updateLibraryTrack(id, name, state.editTags);
    closeModal('modal-edit-track');
    // Refresh whichever view is active
    if (document.getElementById('library-view').style.display !== 'none') {
      await loadLibrary();
    } else if (state.currentSession) {
      await loadTracks(state.currentSession.id);
    }
    showToast('Track updated', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   UPLOAD SOUND MODAL
   ═══════════════════════════════════════════════════════════════════════════════ */
let uploadSoundFiles = [];

function openUploadSoundModal() {
  uploadSoundFiles = [];
  document.getElementById('upload-sound-name-input').value = '';
  document.getElementById('upload-sound-file-input').value = '';
  document.getElementById('sound-file-drop-text').innerHTML = 'Drop audio files here or <span class="file-browse-link">browse</span>';
  document.getElementById('sound-file-drop-zone').classList.remove('has-file', 'dragover');
  document.getElementById('upload-sound-progress-wrap').style.display = 'none';
  document.getElementById('upload-sound-progress-bar').style.width    = '0%';
  document.getElementById('upload-sound-name-row').style.display = '';
  openModal('modal-upload-sound');
  setTimeout(() => document.getElementById('upload-sound-name-input').focus(), 80);
}

async function saveUploadSound() {
  if (!uploadSoundFiles.length) { showToast('Please select an audio file', 'error'); return; }

  const isSingle = uploadSoundFiles.length === 1;
  const name = document.getElementById('upload-sound-name-input').value.trim();
  if (isSingle && !name) { showToast('Sound name is required', 'error'); return; }

  const btn = document.getElementById('btn-save-upload-sound');
  btn.disabled = true;

  const progressWrap = document.getElementById('upload-sound-progress-wrap');
  const progressBar  = document.getElementById('upload-sound-progress-bar');
  const progressText = document.getElementById('upload-sound-progress-text');
  progressWrap.style.display = '';
  progressBar.style.width    = '0%';

  try {
    if (isSingle) {
      progressText.textContent = 'Uploading…';
      const fd = new FormData();
      fd.append('file', uploadSoundFiles[0]);
      fd.append('name', name);
      await api.uploadSoundboardSound(fd);

      progressBar.style.width  = '100%';
      progressText.textContent = 'Upload complete!';
      await loadSoundboard();
      showToast(`"${name}" added to soundboard`, 'success');
      setTimeout(() => closeModal('modal-upload-sound'), 600);
    } else {
      const total = uploadSoundFiles.length;
      let done = 0;
      progressText.textContent = `0 / ${total} uploaded`;

      const results = [];
      for (let i = 0; i < uploadSoundFiles.length; i += 5) {
        const batch = uploadSoundFiles.slice(i, i + 5);
        const batchResults = await Promise.all(batch.map(file => {
          const soundName = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
          const fd = new FormData();
          fd.append('file', file);
          fd.append('name', soundName);
          return api.uploadSoundboardSound(fd)
            .then(() => ({ ok: true }))
            .catch(e => ({ ok: false, error: e.message }))
            .then(result => {
              done++;
              progressBar.style.width  = Math.round(done / total * 100) + '%';
              progressText.textContent = `${done} / ${total} uploaded`;
              return result;
            });
        }));
        results.push(...batchResults);
      }

      await loadSoundboard();
      const succeeded = results.filter(r => r.ok).length;
      const failedCount = total - succeeded;

      if (failedCount === 0) {
        showToast(`${total} sound${total !== 1 ? 's' : ''} added to soundboard`, 'success');
        setTimeout(() => closeModal('modal-upload-sound'), 600);
      } else if (succeeded === 0) {
        showToast(`All ${total} uploads failed`, 'error');
        progressWrap.style.display = 'none';
      } else {
        showToast(`${succeeded} of ${total} uploaded — ${failedCount} failed`, 'error');
        setTimeout(() => closeModal('modal-upload-sound'), 1200);
      }
    }
  } catch (e) {
    showToast('Upload failed: ' + e.message, 'error');
    progressWrap.style.display = 'none';
  } finally {
    btn.disabled = false;
  }
}

function setupSoundFileDropZone() {
  const zone      = document.getElementById('sound-file-drop-zone');
  const input     = document.getElementById('upload-sound-file-input');
  const dropText  = document.getElementById('sound-file-drop-text');
  const nameRow   = document.getElementById('upload-sound-name-row');
  const nameInput = document.getElementById('upload-sound-name-input');
  const allowed   = ['.mp3', '.wav', '.ogg', '.flac', '.m4a'];

  function setFiles(fileList) {
    const files = Array.from(fileList).filter(f => {
      const ext = f.name.substring(f.name.lastIndexOf('.')).toLowerCase();
      return allowed.includes(ext);
    });
    const rejected = fileList.length - files.length;
    if (rejected > 0) showToast(`${rejected} file${rejected !== 1 ? 's' : ''} skipped — unsupported format`, 'error');
    if (!files.length) return;

    uploadSoundFiles = files;
    zone.classList.add('has-file');
    zone.classList.remove('dragover');

    if (files.length === 1) {
      dropText.textContent = `✓ ${files[0].name}`;
      nameRow.style.display = '';
      if (!nameInput.value.trim()) {
        nameInput.value = files[0].name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      }
    } else {
      dropText.textContent = `✓ ${files.length} files selected`;
      nameRow.style.display = 'none';
    }
  }

  zone.addEventListener('click', e => {
    if (e.target.closest('input')) return;
    input.click();
  });

  input.addEventListener('change', () => {
    if (input.files.length) setFiles(input.files);
  });

  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));

  zone.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer.files.length) setFiles(e.dataTransfer.files);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   EDIT SOUND MODAL
   ═══════════════════════════════════════════════════════════════════════════════ */
function openEditSoundModal(sound) {
  state.editingSoundId = sound.id;
  document.getElementById('edit-sound-id').value         = sound.id;
  document.getElementById('edit-sound-name-input').value  = sound.name;
  openModal('modal-edit-sound');
  setTimeout(() => document.getElementById('edit-sound-name-input').focus(), 80);
}

async function saveEditSound() {
  const id   = parseInt(document.getElementById('edit-sound-id').value);
  const name = document.getElementById('edit-sound-name-input').value.trim();
  if (!name) { showToast('Sound name is required', 'error'); return; }

  const btn = document.getElementById('btn-save-edit-sound');
  btn.disabled = true;

  try {
    await api.updateSoundboardSound(id, name);
    closeModal('modal-edit-sound');
    await loadSoundboard();
    showToast('Sound updated', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   LIBRARY PICKER MODAL
   ═══════════════════════════════════════════════════════════════════════════════ */
async function openLibraryPicker() {
  if (!state.currentSession) return;

  // Pre-compute which library tracks are already in this session
  state.libraryPickerAdded = new Set(state.tracks.map(st => st.track.id));

  // Ensure library is loaded
  if (state.libraryTracks.length === 0) {
    try {
      state.libraryTracks = await api.getLibraryTracks();
    } catch (e) {
      showToast('Failed to load library: ' + e.message, 'error');
      return;
    }
  }

  document.getElementById('library-picker-search').value = '';
  renderLibraryPicker('');
  openModal('modal-library-picker');
  setTimeout(() => document.getElementById('library-picker-search').focus(), 80);
}

function renderLibraryPicker(query) {
  const listEl = document.getElementById('library-picker-list');
  const q = query.toLowerCase().trim();

  const filtered = state.libraryTracks.filter(t => {
    if (!q) return true;
    return t.name.toLowerCase().includes(q) ||
           t.tags.some(tag => tag.toLowerCase().includes(q));
  });

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="tracks-empty">No tracks found.</div>`;
    return;
  }

  listEl.innerHTML = filtered.map(track => {
    const already = state.libraryPickerAdded.has(track.id);
    return `
      <div class="picker-track-item${already ? ' already-added' : ''}" data-id="${track.id}">
        <div class="picker-track-info">
          <div class="picker-track-name">${escapeHTML(track.name)}</div>
          <div class="picker-track-tags">${track.tags.map(tagBadgeHTML).join('')}</div>
        </div>
        <button class="picker-add-btn" data-id="${track.id}" ${already ? 'disabled' : ''}>
          ${already ? '✓ Added' : '+ Add'}
        </button>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.picker-add-btn:not(:disabled)').forEach(btn => {
    btn.addEventListener('click', async () => {
      const libId = parseInt(btn.dataset.id);
      btn.disabled    = true;
      btn.textContent = '…';
      try {
        await api.addTrackToSession(state.currentSession.id, libId);
        state.libraryPickerAdded.add(libId);
        btn.textContent = '✓ Added';
        btn.closest('.picker-track-item').classList.add('already-added');
        // Reload session tracks in the background so the list is fresh when closed
        state.tracks = await api.getSessionTracks(state.currentSession.id);
        renderTracks();
        renderTagFilterBar();
      } catch (e) {
        btn.disabled    = false;
        btn.textContent = '+ Add';
        showToast('Error: ' + e.message, 'error');
      }
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   TAG INPUT (shared for upload + edit modals)
   ═══════════════════════════════════════════════════════════════════════════════ */
function renderTagPills(context) {
  // context = 'upload' | 'edit'
  const tags     = context === 'upload' ? state.uploadTags : state.editTags;
  const pillsEl  = document.getElementById(`${context}-tag-pills`);
  pillsEl.innerHTML = tags.map((t, i) => `
    <span class="tag-pill tag-color-${tagColor(t)}">
      ${escapeHTML(t)}
      <button class="tag-pill-remove" data-index="${i}" data-context="${context}">&times;</button>
    </span>`).join('');

  pillsEl.querySelectorAll('.tag-pill-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      if (context === 'upload') state.uploadTags.splice(idx, 1);
      else                      state.editTags.splice(idx, 1);
      renderTagPills(context);
    });
  });
}

function addTagFromInput(context) {
  const fieldId = context === 'upload' ? 'upload-tag-field' : 'edit-tag-field';
  const field   = document.getElementById(fieldId);
  const raw     = field.value;
  const tags    = raw.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
  const target  = context === 'upload' ? state.uploadTags : state.editTags;

  tags.forEach(tag => {
    if (!target.includes(tag)) target.push(tag);
  });

  field.value = '';
  renderTagPills(context);
}

function setupTagInput(context) {
  const fieldId = context === 'upload' ? 'upload-tag-field' : 'edit-tag-field';
  const wrapId  = context === 'upload' ? 'upload-tag-input-wrap' : 'edit-tag-input-wrap';
  const field   = document.getElementById(fieldId);
  const wrap    = document.getElementById(wrapId);

  field.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTagFromInput(context);
    } else if (e.key === 'Backspace' && field.value === '') {
      const target = context === 'upload' ? state.uploadTags : state.editTags;
      if (target.length > 0) {
        target.pop();
        renderTagPills(context);
      }
    }
  });

  field.addEventListener('blur', () => {
    if (field.value.trim()) addTagFromInput(context);
  });

  // Click anywhere in wrap focuses the field
  wrap.addEventListener('click', () => field.focus());
}

/* ═══════════════════════════════════════════════════════════════════════════════
   FILE DROP ZONE
   ═══════════════════════════════════════════════════════════════════════════════ */
function setupFileDropZone() {
  const zone      = document.getElementById('file-drop-zone');
  const input     = document.getElementById('upload-file-input');
  const dropText  = document.getElementById('file-drop-text');
  const nameRow   = document.getElementById('upload-name-row');
  const nameInput = document.getElementById('upload-name-input');
  const allowed   = ['.mp3','.wav','.ogg','.flac','.m4a'];

  function setFiles(fileList) {
    const files = Array.from(fileList).filter(f => {
      const ext = f.name.substring(f.name.lastIndexOf('.')).toLowerCase();
      return allowed.includes(ext);
    });
    const rejected = fileList.length - files.length;
    if (rejected > 0) showToast(`${rejected} file${rejected !== 1 ? 's' : ''} skipped — unsupported format`, 'error');
    if (!files.length) return;

    const existingNames = new Set(
      (state.libraryTracks || []).map(t => (t.original_filename || '').toLowerCase())
    );
    const duplicates = files.filter(f => existingNames.has(f.name.toLowerCase()));
    const unique     = files.filter(f => !existingNames.has(f.name.toLowerCase()));
    if (duplicates.length > 0) {
      const names = duplicates.map(f => f.name).join(', ');
      showToast(`Already in library, skipped: ${names}`, 'info');
    }
    if (!unique.length) return;

    uploadFiles = unique;
    zone.classList.add('has-file');
    zone.classList.remove('dragover');

    if (files.length === 1) {
      dropText.textContent = `✓ ${files[0].name}`;
      nameRow.style.display = '';
      if (!nameInput.value.trim()) {
        nameInput.value = files[0].name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      }
    } else {
      dropText.textContent = `✓ ${files.length} files selected`;
      nameRow.style.display = 'none';
    }
  }

  zone.addEventListener('click', e => {
    if (e.target.closest('input')) return;
    input.click();
  });

  input.addEventListener('change', () => {
    if (input.files.length) setFiles(input.files);
  });

  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));

  zone.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer.files.length) setFiles(e.dataTransfer.files);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   TOAST NOTIFICATIONS
   ═══════════════════════════════════════════════════════════════════════════════ */
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${escapeHTML(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('removing');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, 3500);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   UTILITY
   ═══════════════════════════════════════════════════════════════════════════════ */
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   EVENT LISTENERS — PLAYER BAR
   ═══════════════════════════════════════════════════════════════════════════════ */
function initPlayerEvents() {
  // Queue panel toggle
  document.getElementById('btn-open-queue').addEventListener('click', toggleQueuePanel);
  document.getElementById('btn-close-queue').addEventListener('click', closeQueuePanel);
  document.getElementById('queue-panel-overlay').addEventListener('click', closeQueuePanel);
  document.getElementById('btn-clear-queue').addEventListener('click', () => {
    if (state.queue.length === 0) return;
    queueClear();
    showToast('Queue cleared', 'info');
  });

  // Play / Pause
  document.getElementById('btn-play-pause').addEventListener('click', () => {
    if (state.isPlaying) {
      audio.pause();
    } else {
      if (audio.src) {
        audio.play().catch(() => {});
      } else if (state.queue.length > 0) {
        const idx = Math.max(0, state.queueIndex);
        playTrackFromQueue(idx);
      }
    }
  });

  // Previous
  document.getElementById('btn-prev').addEventListener('click', () => {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    const prev = state.queueIndex - 1;
    if (prev >= 0) playTrackFromQueue(prev);
  });

  // Next
  document.getElementById('btn-next').addEventListener('click', () => {
    advanceQueue();
  });

  // Loop
  document.getElementById('btn-loop').addEventListener('click', () => {
    state.isLooping = !state.isLooping;
    document.getElementById('btn-loop').classList.toggle('active', state.isLooping);
    showToast(state.isLooping ? 'Loop on' : 'Loop off', 'info');
  });

  // Volume slider
  const volSlider = document.getElementById('volume-slider');
  volSlider.addEventListener('input', () => {
    state.isMuted  = false;
    state.prevVolume = parseFloat(volSlider.value);
    setVolume(parseFloat(volSlider.value));
  });

  // Mute toggle
  document.getElementById('vol-icon').addEventListener('click', () => {
    if (state.isMuted) {
      state.isMuted = false;
      setVolume(state.prevVolume || 0.8);
      volSlider.value = state.volume;
    } else {
      state.prevVolume = state.volume;
      state.isMuted    = true;
      audio.volume     = 0;
      state.layeredTracks.forEach(l => { l.audio.volume = 0; });
      state.activeSoundInstances.forEach(s => { s.audio.volume = 0; });
      updateVolIcon();
    }
  });

  // Crossfade toggle
  document.getElementById('btn-crossfade').addEventListener('click', () => {
    state.isCrossfade = !state.isCrossfade;
    document.getElementById('btn-crossfade').classList.toggle('active', state.isCrossfade);
    document.getElementById('crossfade-slider-wrap').style.display = state.isCrossfade ? 'flex' : 'none';
    showToast(state.isCrossfade ? 'Crossfade on' : 'Crossfade off', 'info');
  });

  // Crossfade slider
  const cfSlider = document.getElementById('crossfade-slider');
  cfSlider.addEventListener('input', () => {
    state.crossfadeSecs = parseFloat(cfSlider.value);
    document.getElementById('crossfade-value').textContent = state.crossfadeSecs + 's';
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   EVENT LISTENERS — SIDEBAR / TOOLBAR
   ═══════════════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════════════
   SIDEBAR TOGGLE (tablet)
   ═══════════════════════════════════════════════════════════════════════════════ */
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('visible');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
}

function isTablet() {
  return window.innerWidth <= 1024;
}

function initStaticEvents() {
  // Sidebar tabs: Campaigns / Library / Soundboard
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      if (tab.dataset.tab === 'library') {
        if (isTablet()) closeSidebar();
        showLibraryView();
      } else if (tab.dataset.tab === 'soundboard') {
        if (isTablet()) closeSidebar();
        showSoundboardView();
      } else {
        // Switch back to campaigns tab — show welcome or current session
        document.getElementById('library-view').style.display = 'none';
        document.getElementById('soundboard-view').style.display = 'none';
        if (state.currentSession) {
          document.getElementById('session-view').style.display = 'flex';
        } else {
          document.getElementById('main-empty').style.display = '';
        }
      }
    });
  });

  // Sidebar toggle (hamburger)
  document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    if (sidebar.classList.contains('open')) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  // Sidebar close button (inside sidebar)
  document.getElementById('btn-close-sidebar').addEventListener('click', closeSidebar);

  // Tap overlay to close sidebar
  document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);

  // Add campaign button
  document.getElementById('btn-add-campaign').addEventListener('click', openAddCampaignModal);

  // Upload track to library (from library view header)
  document.getElementById('btn-upload-library-track').addEventListener('click', openUploadModal);

  // Add from library (from session view header)
  document.getElementById('btn-add-from-library').addEventListener('click', openLibraryPicker);

  // Library picker search
  document.getElementById('library-picker-search').addEventListener('input', e => {
    renderLibraryPicker(e.target.value);
  });

  // Clear session tag filter
  // Clear session tag filter
  document.getElementById('btn-clear-filter').addEventListener('click', () => {
    state.activeTags.clear();
    renderTracks();
    renderTagFilterBar();
  });

  // Clear library tag filter
  document.getElementById('btn-clear-library-filter').addEventListener('click', () => {
    state.activeLibraryTags.clear();
    renderLibrary();
    renderLibraryTagFilterBar();
  });

  // ── Modal: Campaign ────────────────────────────────────────────────────────
  document.getElementById('btn-save-campaign').addEventListener('click', saveCampaign);
  document.getElementById('campaign-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveCampaign();
  });

  // ── Modal: Session ─────────────────────────────────────────────────────────
  document.getElementById('btn-save-session').addEventListener('click', saveSession);
  document.getElementById('session-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveSession();
  });

  // ── Modal: Upload Track ────────────────────────────────────────────────────
  document.getElementById('btn-save-upload').addEventListener('click', saveUpload);

  // ── Modal: Edit Track ──────────────────────────────────────────────────────
  document.getElementById('btn-save-edit-track').addEventListener('click', saveEditTrack);
  document.getElementById('edit-track-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveEditTrack();
  });

  // ── Soundboard ──────────────────────────────────────────────────────────────
  document.getElementById('btn-upload-sound').addEventListener('click', openUploadSoundModal);
  document.getElementById('btn-stop-all-sounds').addEventListener('click', stopAllSoundboardSounds);

  // ── Modal: Upload Sound ─────────────────────────────────────────────────────
  document.getElementById('btn-save-upload-sound').addEventListener('click', saveUploadSound);

  // ── Modal: Edit Sound ───────────────────────────────────────────────────────
  document.getElementById('btn-save-edit-sound').addEventListener('click', saveEditSound);
  document.getElementById('edit-sound-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveEditSound();
  });

  // ── Modal: Confirm Delete ──────────────────────────────────────────────────
  document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
    if (state.confirmCallback) {
      const cb = state.confirmCallback;
      state.confirmCallback = null;
      closeModal('modal-confirm');
      try {
        await cb();
      } catch (e) {
        showToast('Error: ' + e.message, 'error');
      }
    }
  });

  // ── Generic modal close (data-close attribute) ─────────────────────────────
  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', () => closeModal(el.dataset.close));
  });

  // Click overlay to close
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // Escape key closes top-most modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const open = [...document.querySelectorAll('.modal-overlay')]
        .filter(el => el.style.display !== 'none');
      if (open.length > 0) closeModal(open[open.length - 1].id);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════════════════════ */
async function init() {
  initProgressBar();
  initPlayerEvents();
  initStaticEvents();
  setupTagInput('upload');
  setupTagInput('edit');
  setupFileDropZone();
  setupSoundFileDropZone();

  // Set initial volume
  audio.volume = state.volume;
  document.getElementById('volume-slider').value = state.volume;
  updateVolIcon();
  updateQueueCount();
  updatePlayBtn();

  // Load campaigns
  await loadCampaigns();
}

document.addEventListener('DOMContentLoaded', init);

