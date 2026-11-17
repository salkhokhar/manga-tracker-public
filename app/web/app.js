// ── State ─────────────────────────────────────────────────────────────────────
let ALL_COMICS     = [];
let ONLINE_RESULTS = [];
let currentChapters = [];
let currentChapterIdx = -1;
let currentSort    = 'collection';
let sortDesc       = true;
let currentComic   = null;
let currentChapter = 0;
let _renderToken   = 0;
let refreshPoll    = null;
let detailSource   = 'dashboard'; // 'dashboard' or 'explore'
let dashboardScrollY = 0;         // Track scroll position
let explorePage    = {};          // track pages loaded per combination
let currentUser    = null;        // { email, id } when logged in, null otherwise
let activeFilters  = {
  categories: new Set(),
  statuses: new Set(),
  genres: new Set()
};

// ── Image Loading Queue ──────────────────────────────────────────────────────
const ImageQueue = {
  active: 0,
  max: 8,
  pending: [],
  add(img, url) {
    this.pending.push({ img, url });
    this.process();
  },
  process() {
    while (this.active < this.max && this.pending.length > 0) {
      const { img, url } = this.pending.shift();
      this.active++;
      img.onload = img.onerror = () => {
        this.active--;
        this.process();
        if (img.complete) img.style.opacity = '1';
      };
      img.src = url;
    }
  }
};

// ── Shutdown hook ─────────────────────────────────────────────────────────────


// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  setupSortButtons();
  await checkAuthStatus();   // Must run first — shows login screen if not logged in
  await loadSites();
  await loadComics();
  populateFilters();
  hideLoader();
  renderDashboard();
});

// ── Sites & Settings ──────────────────────────────────────────────────────────
let AVAILABLE_SITES = {};

async function loadSites() {
  try {
    const res = await fetch('/api/sites');
    AVAILABLE_SITES = await res.json();
    populateSiteDropdowns();
  } catch (e) {
    console.error('Failed to load sites:', e);
  }
}

function populateSiteDropdowns() {
  const sites = Object.keys(AVAILABLE_SITES).sort();
  const defExplore = localStorage.getItem('defaultExploreSite') || 'MangaRead';
  const defSearch  = localStorage.getItem('defaultSearchSite') || 'MangaRead';

  const selects = [
    { id: 'explore-site', def: defExplore },
    { id: 'search-site', def: defSearch },
    { id: 'settings-default-explore', def: defExplore },
    { id: 'settings-default-search', def: defSearch }
  ];

  selects.forEach(({ id, def }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    sites.forEach(site => {
      const opt = document.createElement('option');
      opt.value = site;
      opt.textContent = site;
      if (site === def) opt.selected = true;
      el.appendChild(opt);
    });
  });
  
  // Trigger update for explore filters based on selected site
  onExploreSiteChange();
}

function onExploreSiteChange() {
  const site = document.getElementById('explore-site')?.value;
  if (!site || !AVAILABLE_SITES[site]) return;
  
  const siteData = AVAILABLE_SITES[site];
  
  const catSelect = document.getElementById('explore-cat');
  if (catSelect) {
    const currCat = catSelect.value;
    catSelect.innerHTML = '';
    siteData.types.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
      if (t === currCat) opt.selected = true;
      catSelect.appendChild(opt);
    });
  }
  
  const orderSelect = document.getElementById('explore-order');
  if (orderSelect) {
    const currOrder = orderSelect.value;
    const orderMap = {"Newest":"new-manga", "Latest":"latest", "Popular":"trending", "Rating":"rating", "A-Z":"alphabet"};
    orderSelect.innerHTML = '';
    siteData.orders.forEach(o => {
      const val = orderMap[o] || 'latest';
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = o;
      if (val === currOrder) opt.selected = true;
      orderSelect.appendChild(opt);
    });
  }
}

document.getElementById('explore-site')?.addEventListener('change', () => {
  onExploreSiteChange();
  updateExploreView();
});

function openSettings() {
  const accountSection = document.getElementById('settings-account');
  const settingsEmail  = document.getElementById('settings-email');
  const settingsAvatar = document.getElementById('settings-avatar');
  if (currentUser) {
    if (accountSection) accountSection.classList.remove('hidden');
    // Show username (with @) as primary, email secondary
    if (settingsAvatar) settingsAvatar.textContent = currentUser.username
      ? currentUser.username[0].toUpperCase()
      : (currentUser.email || '?')[0].toUpperCase();
    if (settingsEmail) settingsEmail.textContent = currentUser.username
      ? `@${currentUser.username} • ${currentUser.email}`
      : currentUser.email;
  } else {
    if (accountSection) accountSection.classList.add('hidden');
  }
  document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}

function saveSettings() {
  const exp = document.getElementById('settings-default-explore').value;
  const src = document.getElementById('settings-default-search').value;
  localStorage.setItem('defaultExploreSite', exp);
  localStorage.setItem('defaultSearchSite', src);
  
  document.getElementById('explore-site').value = exp;
  document.getElementById('search-site').value = src;
  onExploreSiteChange();
  closeSettings();
}

async function loadComics() {
  try {
    const res = await fetch('/api/comics');
    ALL_COMICS = await res.json();
  } catch (e) {
    console.error('Failed to load comics', e);
  }
}

function hideLoader() {
  const l = document.getElementById('loader');
  if (l) {
    l.style.opacity = '0';
    setTimeout(() => l.classList.add('hidden'), 400);
  }
}

function exportLibrary(format) {
  // Triggers a file download directly from the backend
  const a = document.createElement('a');
  a.href = `/api/export?format=${format}`;
  a.download = `manga_tracker_export.${format}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Sorting & Filtering ───────────────────────────────────────────────────────
function getDisplayList() {
  let list = [...ALL_COMICS];
  const searchInput = document.getElementById('search');
  const q = searchInput ? searchInput.value.trim().toLowerCase() : '';
  
  if (q) {
    list = list.filter(c => 
      (c.title || '').toLowerCase().includes(q) || 
      (c.altNames && c.altNames.toLowerCase().includes(q))
    );
  }

  // Inclusive filters
  if (activeFilters.categories.size > 0) {
    list = list.filter(c => activeFilters.categories.has(c.category));
  }
  if (activeFilters.statuses.size > 0) {
    list = list.filter(c => activeFilters.statuses.has(c.status));
  }
  if (activeFilters.genres.size > 0) {
    list = list.filter(c => {
      const cGenres = (c.genre || '').split(',').map(g => g.trim());
      return [...activeFilters.genres].every(g => cGenres.includes(g));
    });
  }

  switch (currentSort) {
    case 'favorites':
      list = list.filter(c => c.favorite);
      list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      break;
    case 'lastRead':
      list.sort((a, b) => parseDate(b.date) - parseDate(a.date));
      break;
    case 'latestUpdate':
      list.sort((a, b) => parseDate(b.latestDateRaw || b.latestDate) - parseDate(a.latestDateRaw || a.latestDate));
      break;
    case 'collection':
      break; 
    default:
      break;
  }

  if (!sortDesc) list.reverse();
  
  const onlineCheck = document.getElementById('search-online-cb');
  if (q && onlineCheck && onlineCheck.checked) {
    const localTitles = new Set(list.map(c => (c.title || '').toLowerCase()));
    const filteredOnline = ONLINE_RESULTS.filter(c => !localTitles.has((c.title || '').toLowerCase()));
    list = [...list, ...filteredOnline];
  }
  
  return list;
}

function parseDate(s) {
  if (!s || typeof s !== 'string') return 0;
  const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  
  let m = s.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = MONTHS[m[2].toLowerCase()];
    const year = parseInt(m[3], 10);
    if (month !== undefined) return new Date(year, month, day).getTime();
  }

  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1]).getTime();

  // UTC timestamp written by the phone / scheduled check: "2026-10-26T13:05Z"
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (m) return Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5]);

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]).getTime();

  return 0;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function renderDashboard() {
  const list  = getDisplayList();
  const grid  = document.getElementById('grid');
  const empty = document.getElementById('empty-state');
  const badge = document.getElementById('count-badge');
  if (badge) badge.textContent = `${list.length} title${list.length !== 1 ? 's' : ''}`;

  if (!grid) return;

  _renderToken++;
  const myToken = _renderToken;

  grid.innerHTML = '';

  if (list.length === 0) {
    grid.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    return;
  }
  grid.classList.remove('hidden');
  if (empty) empty.classList.add('hidden');

  const BATCH = 40;
  let idx = 0;

  function renderBatch() {
    if (_renderToken !== myToken) return;
    const end  = Math.min(idx + BATCH, list.length);
    const frag = document.createDocumentFragment();
    for (let i = idx; i < end; i++) {
      frag.appendChild(buildCard(list[i]));
    }
    grid.appendChild(frag);
    idx = end;
    if (idx < list.length) requestAnimationFrame(renderBatch);
  }

  requestAnimationFrame(renderBatch);
  updateNotifications();
}

function buildCard(c, source='dashboard') {
  try {
    const div = document.createElement('div');
    div.className = 'card';
    div.addEventListener('click', () => showDetail(c, source));

    const chNum     = extractNum(c.chapter);
    const latestNum = extractNum(c.latestCh);
    const hasNew    = latestNum > chNum && latestNum > 0;
    const title     = c.title || 'Untitled Comic';

    const url = c.coverUrl || '';
    const inLibrary = c.isOnlineOnly && ALL_COMICS.some(m => norm(m.title) === norm(title));
    // Library cards show the site's average (siteRating); Explore cards carry
    // the listing's own number as `rating`.
    const rating = c.siteRating || (c.isOnlineOnly ? (c.rating || c.Rating || '') : '');
    const status = (c.status || c.Status || '').trim();
    const category = (c.category || c.Category || '').trim();
    
    div.innerHTML = `
      <div class="card-cover-wrap">
        <img alt="${escHtml(title)}" class="cover-img" style="opacity:0" />
        ${category   ? `<span class="card-category-badge">${escHtml(category)}</span>` : ''}
        ${c.favorite ? '<span class="card-fav-badge">❤️</span>' : ''}
        ${inLibrary  ? '<span class="card-library-badge">In Library</span>' : ''}
        ${hasNew     ? '<span class="card-new-badge">New</span>'  : ''}
        ${rating     ? `<span class="card-rating-badge">⭐ ${escHtml(rating)}</span>` : ''}
      </div>
      <div class="card-body">
        <div class="card-title">${escHtml(title)}</div>
        ${status ? `
          <div class="card-status-line" style="color:${status.toLowerCase()==='completed' ? 'var(--green)' : 'var(--accent2)'}">
            <span class="status-dot" style="background:${status.toLowerCase()==='completed' ? 'var(--green)' : 'var(--accent2)'}"></span>
            ${escHtml(status)}
          </div>
        ` : ''}
        
        ${c.isOnlineOnly ? `
          <div style="margin-top:auto; padding-top:8px; color:var(--text3); font-size:0.75rem; font-weight:700; border-top:1px solid var(--border); text-transform:uppercase; letter-spacing:0.05em;">
            🌐 Online Result
          </div>
        ` : `
          <div class="card-info-grid">
             <div class="info-item">
               <span class="label">READ</span>
               <span class="val">${escHtml(c.chapter) || '—'}</span>
             </div>
             <div class="info-item ${hasNew ? 'accent' : ''}">
               <span class="label">LATEST</span>
               <span class="val">${escHtml(c.latestCh) || '—'}</span>
             </div>
          </div>
          <div class="card-date">${escHtml(c.date) || ''}</div>
        `}
      </div>`;

    if (url) {
      const img = div.querySelector('.cover-img');
      ImageQueue.add(img, url);
    }

    return div;
  } catch (e) {
    console.error('buildCard failed', e, c);
    return document.createElement('div');
  }
}

// ── Sort Controls ─────────────────────────────────────────────────────────────
function setupSortButtons() {
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSort = btn.dataset.sort;
      renderDashboard();
    };
  });
}

function toggleDir() {
  sortDesc = !sortDesc;
  const btn = document.getElementById('dir-btn');
  if (btn) btn.textContent = sortDesc ? '↓ Descending' : '↑ Ascending';
  renderDashboard();
}

// ── Refresh Library ──────────────────────────────────────────────────────────
async function onRefreshLibrary() {
  const btn = document.getElementById('refresh-btn');
  if (btn && btn.classList.contains('spinning')) return;

  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    if (!res.ok) throw new Error('Refresh already running');
    
    if (btn) btn.classList.add('spinning');
    toggleToast(true);
    startPolling();
  } catch (e) {
    alert(e.message);
  }
}

function toggleToast(show) {
  const toast = document.getElementById('refresh-toast');
  if (toast) toast.classList.toggle('hidden', !show);
}

function startPolling() {
  if (refreshPoll) clearInterval(refreshPoll);
  refreshPoll = setInterval(pollRefreshStatus, 1500);
}

async function pollRefreshStatus() {
  try {
    const res = await fetch('/api/refresh/status');
    const data = await res.json();
    
    const fill = document.getElementById('toast-progress-fill');
    const text = document.getElementById('toast-progress-text');
    const status = document.getElementById('toast-status');
    const btn = document.getElementById('refresh-btn');
    
    if (data.running) {
      const pct = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;
      if (fill) fill.style.width = `${pct}%`;
      if (text) text.textContent = `${pct}%`;
      if (status) status.textContent = data.status || 'Syncing...';
    } else {
      clearInterval(refreshPoll);
      refreshPoll = null;
      if (btn) btn.classList.remove('spinning');
      
      if (status) status.textContent = 'Sync complete!';
      if (fill) fill.style.width = '100%';
      if (text) text.textContent = '100%';
      
      setTimeout(() => {
        toggleToast(false);
        loadComics().then(() => {
          populateFilters();
          renderDashboard();
        });
      }, 2000);
    }
  } catch (e) {
    console.error('Polling failed', e);
    clearInterval(refreshPoll);
  }
}

// ── Search ────────────────────────────────────────────────────────────────────
let searchTimeout;
function onSearchInput() {
  const searchInput = document.getElementById('search');
  const q = searchInput ? searchInput.value : '';
  const clearBtn = document.getElementById('search-clear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !q);
  
  const onlineCheck = document.getElementById('search-online-cb');
  if (onlineCheck && onlineCheck.checked && q.length > 2) {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      fetchOnlineSearch(q);
    }, 1000);
  } else {
    ONLINE_RESULTS = [];
  }
  
  if (document.getElementById('detail').classList.contains('hidden')) {
    renderDashboard();
  }
}

function onToggleOnline() {
  const q = document.getElementById('search').value;
  if (!document.getElementById('search-online-cb').checked) {
    ONLINE_RESULTS = [];
    renderDashboard();
  } else if (q.length > 2) {
    fetchOnlineSearch(q);
  }
}
async function fetchOnlineSearch(q) {
  try {
    const site = document.getElementById('search-site')?.value || 'MangaRead';
    const res = await fetch(`/api/search_online?q=${encodeURIComponent(q)}&site=${encodeURIComponent(site)}`);
    const data = await res.json();
    ONLINE_RESULTS = data;
    renderDashboard();
  } catch (e) {
    console.error(e);
  }
}
function onSearch() {
  onSearchInput(); 
  const q = document.getElementById('search').value;
  if (document.getElementById('search-online-cb').checked && q.length > 2) {
     if (searchTimeout) clearTimeout(searchTimeout);
     fetchOnlineSearch(q);
  }
}

function clearSearch() {
  const searchInput = document.getElementById('search');
  if (searchInput) searchInput.value = '';
  const clearBtn = document.getElementById('search-clear');
  if (clearBtn) clearBtn.classList.add('hidden');
  ONLINE_RESULTS = [];
  renderDashboard();
}

// ── Detail View ───────────────────────────────────────────────────────────────
async function showDetail(c, source) {
  if (source !== 'explore') {
    dashboardScrollY = window.scrollY;
  }
  detailSource   = source || 'dashboard';
  currentComic   = null; // Reset current comic to avoid stale logic
  currentChapter = extractNum(c.chapter);

  // Immediately clear UI to prevent "ghosting" from previous comic
  document.getElementById('detail-cover').src   = '';
  document.getElementById('detail-cover').alt   = '';
  document.getElementById('detail-title').textContent    = 'Loading...';
  document.getElementById('detail-author').textContent   = '';
  document.getElementById('detail-rating').textContent   = '';
  document.getElementById('detail-altnames').textContent = '';
  document.getElementById('detail-genre').textContent    = '';
  document.getElementById('detail-desc').textContent     = '';
  document.getElementById('detail-last-read').textContent = '';
  document.getElementById('detail-latest').textContent    = '';
  document.getElementById('chapter-list').innerHTML       = '';
  document.getElementById('detail-chapter-card').classList.add('hidden');
  document.getElementById('chapter-spinner').classList.remove('hidden');

  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('explore-view').classList.add('hidden');
  document.getElementById('detail').classList.remove('hidden');
  document.getElementById('back-btn').classList.remove('hidden');
  document.getElementById('back-btn').textContent = detailSource === 'explore' ? '← Explore' : '← Library';

  let details = Object.assign({}, c);
  const existing = ALL_COMICS.find(m => norm(m.title) === norm(c.title));
  if (existing) {
      details = Object.assign({}, existing, { isOnlineOnly: false });
  }
  currentComic = details; 
  
  if (details.isOnlineOnly) {
     toggleToast(true);
     document.getElementById('toast-status').textContent = 'Fetching details...';
     document.getElementById('toast-progress-fill').style.width = '100%';
     document.getElementById('toast-progress-text').textContent = '';
     try {
       const res = await fetch(`/api/scrape_details?url=${encodeURIComponent(c.mangaUrl)}`);
       const full = await res.json();
       details = Object.assign({}, c, full, { title: full.Title });
       currentComic = details;
     } catch (e) { console.error(e); }
     setTimeout(() => toggleToast(false), 500);
  }

  document.getElementById('detail-cover').src   = details.coverUrl || '';
  document.getElementById('detail-cover').alt   = details.title || '';
  document.getElementById('detail-title').textContent    = details.title || '';
  document.getElementById('detail-author').textContent   = (details.author || details.Author) ? `By ${details.author || details.Author}` : '';
  const siteRating = details.siteRating || details['Site Rating'] || '';
  const yourRating = details.rating || details.Rating || '';
  document.getElementById('detail-rating').textContent   = [
    siteRating ? `⭐ ${siteRating} / 5` : '',
    yourRating ? `Your rating: ${yourRating} / 5` : '',
  ].filter(Boolean).join('   ');
  document.getElementById('detail-altnames').textContent = (details.altNames || details['Alternative Names']) ? `Also known as: ${details.altNames || details['Alternative Names']}` : '';
  document.getElementById('detail-genre').textContent    = details.genre || details.Genre || '';
  document.getElementById('detail-status').textContent   = (details.status || details.Status) ? `Status: ${details.status || details.Status}` : '';
  document.getElementById('detail-category').textContent = (details.category || details.Category) ? `Type: ${details.category || details.Category}` : '';
  document.getElementById('detail-notes-input').value    = details.notes || details.Notes || '';
  document.getElementById('save-note-btn').style.display = 'none';

  const link = document.getElementById('detail-link');
  if (details.mangaUrl) {
      link.href = details.mangaUrl;
      link.classList.remove('hidden');
      
      let siteName = details.site;
      if (!siteName) {
          try {
              const urlObj = new URL(details.mangaUrl);
              siteName = urlObj.hostname.replace('www.', '');
          } catch (e) {
              siteName = 'web';
          }
      }
      link.textContent = `Open on ${siteName} ↗`;
  } else {
      link.classList.add('hidden');
  }

  document.getElementById('detail-last-read').textContent = `Last Read: ${details.chapter || '—'} (${details.date || ''})`;
  document.getElementById('detail-latest').textContent    = details.latestCh ? `Latest: ${details.latestCh} (${details.latestDate || ''})` : '';

  const latest = extractNum(details.latestCh);
  const pct    = latest > 0 ? Math.min(100, Math.round(currentChapter / latest * 100)) : 0;
  document.getElementById('progress-fill').style.width = `${pct}%`;
  document.getElementById('progress-pct').textContent  = `${pct}%`;
  document.getElementById('chapter-input').value = currentChapter;
  
  if (details.isOnlineOnly) {
     document.getElementById('detail-progress-card').classList.add('hidden');
     document.getElementById('detail-add-card').classList.remove('hidden');
     document.getElementById('fav-btn').classList.add('hidden');
     document.getElementById('delete-btn').classList.add('hidden');
  } else {
     document.getElementById('detail-progress-card').classList.remove('hidden');
     document.getElementById('detail-add-card').classList.add('hidden');
     document.getElementById('fav-btn').classList.remove('hidden');
     document.getElementById('delete-btn').classList.remove('hidden');
  }

  document.getElementById('detail-chapter-card').classList.add('hidden');
  document.getElementById('chapter-spinner').classList.remove('hidden');
  document.getElementById('chapter-list').innerHTML = '';

  if (details.mangaUrl) {
    document.getElementById('detail-chapter-card').classList.remove('hidden');
    fetch(`/api/manga_chapters?url=${encodeURIComponent(details.mangaUrl)}`)
      .then(r => r.json())
      .then(chaps => {
         document.getElementById('chapter-spinner').classList.add('hidden');
         renderChapterList(chaps);
      })
      .catch(e => {
         console.error(e);
         document.getElementById('chapter-spinner').classList.add('hidden');
      });
  }

  updateFavBtn();
  let descText = details.description || details.Description || 'No description available.';
  descText = descText.replace(/^A brief description of the manga [^:]+:\s*/i, '');
  document.getElementById('detail-desc').textContent = descText;
  document.getElementById('detail').scrollTop = 0;
}

async function addCurrentToLibrary() {
  if (!currentComic || !currentComic.isOnlineOnly) return;
  const btn = document.getElementById('add-lib-btn');
  const span = btn.querySelector('.btn-text');

  span.textContent = 'Adding...';
  btn.disabled = true;

  try {
    // Controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

    const res = await fetch('/api/add_manga', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: currentComic.mangaUrl }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    const data = await res.json();

    if (res.ok && data.ok) {
       span.textContent = 'Added ✓';
       btn.style.background = 'var(--green)';
       await loadComics();

       const newVer = ALL_COMICS.find(m => norm(m.title) === norm(currentComic.title));
       if (newVer) {
         currentComic = Object.assign({}, newVer, { isOnlineOnly: false });
       } else {
         currentComic.isOnlineOnly = false;
       }

       document.getElementById('detail-add-card').classList.add('hidden');
       showDetail(currentComic, detailSource);
       updateExploreGridBadges(); // Refresh explore badges
    } else if (res.status === 409 || (data && data.msg === 'In Library')) {
       span.textContent = 'In Library ✓';
       await loadComics();
       const existing = ALL_COMICS.find(m => norm(m.title) === norm(currentComic.title));
       if (existing) {
          currentComic = Object.assign({}, existing, { isOnlineOnly: false });
          document.getElementById('detail-add-card').classList.add('hidden');
          showDetail(currentComic, detailSource);
       } else {
          currentComic.isOnlineOnly = false;
          showDetail(currentComic, detailSource);
       }
       updateExploreGridBadges();
    } else {
       span.textContent = (data && data.msg) || 'Failed to add';
       setTimeout(() => { span.textContent = 'Add to Library'; btn.disabled = false; }, 2500);
    }
  } catch (e) {
    console.error(e);
    span.textContent = e.name === 'AbortError' ? 'Request timed out' : 'Network error';
    setTimeout(() => { span.textContent = 'Add to Library'; btn.disabled = false; }, 2500);
  }
}

function updateExploreGridBadges() {
  const grid = document.getElementById('explore-grid');
  if (!grid) return;
  const cards = grid.querySelectorAll('.card');
  cards.forEach(card => {
    const titleEl = card.querySelector('.card-title');
    if (!titleEl) return;
    const title = titleEl.textContent;
    const isLocal = ALL_COMICS.some(m => norm(m.title) === norm(title));
    
    let badge = card.querySelector('.card-library-badge');
    if (isLocal) {
      if (!badge) {
        const coverWrap = card.querySelector('.card-cover-wrap');
        if (coverWrap) {
          badge = document.createElement('span');
          badge.className = 'card-library-badge';
          badge.textContent = 'In Library';
          coverWrap.appendChild(badge);
        }
      }
    } else if (badge) {
      badge.remove();
    }
  });
}
async function confirmDelete() {
  if (!currentComic || currentComic.isOnlineOnly) return;
  if (!confirm(`Are you sure you want to delete "${currentComic.title}" from your library?`)) return;
  
  const btn = document.getElementById('delete-btn');
  const oldText = btn.textContent;
  btn.textContent = 'Deleting...';
  btn.disabled = true;
  
  try {
    const res = await fetch('/api/delete_manga', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: currentComic.title })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
       btn.textContent = 'Deleted ✓';
       await loadComics();
       setTimeout(() => {
          showDashboard();
          btn.textContent = oldText;
          btn.disabled = false;
       }, 1000);
    } else {
       btn.textContent = data.msg || 'Failed to delete';
       setTimeout(() => { btn.textContent = oldText; btn.disabled = false; }, 2500);
    }
  } catch (e) {
    console.error(e);
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = oldText; btn.disabled = false; }, 2500);
  }
}

function updateFavBtn() {
  const btn = document.getElementById('fav-btn');
  if (currentComic && currentComic.favorite) {
    btn.textContent = '❤️ Favorited';
    btn.classList.add('active');
  } else {
    btn.textContent = '🤍 Add to Favorites';
    btn.classList.remove('active');
  }
}

function showDashboard() {
  document.getElementById('detail').classList.add('hidden');
  document.getElementById('explore-view').classList.add('hidden');
  if (detailSource === 'explore') {
    document.getElementById('explore-view').classList.remove('hidden');
  } else {
    document.getElementById('dashboard').classList.remove('hidden');
    renderDashboard();
    window.scrollTo(0, dashboardScrollY);
  }
  document.getElementById('back-btn').classList.add('hidden');
  detailSource = 'dashboard';
}

// ── Chapter Controls ──────────────────────────────────────────────────────────
function changeChapter(delta) {
  currentChapter = Math.max(0, currentChapter + delta);
  document.getElementById('chapter-input').value = currentChapter;
  saveChapter();
  refreshProgress();
}

function onChapterInput() {
  const val = parseInt(document.getElementById('chapter-input').value, 10);
  if (!isNaN(val) && val >= 0) {
    currentChapter = val;
    saveChapter();
    refreshProgress();
  }
}

function markLatestRead() {
  if (!currentComic || !currentComic.latestCh) return;
  const latestNum = extractNum(currentComic.latestCh);
  if (latestNum > 0) {
    currentChapter = latestNum;
    document.getElementById('chapter-input').value = latestNum;
    saveChapter();
    refreshProgress();
  }
}

function refreshProgress() {
  const latest = extractNum(currentComic?.latestCh);
  const pct    = latest > 0 ? Math.min(100, Math.round(currentChapter / latest * 100)) : 0;
  const fill = document.getElementById('progress-fill');
  const pct_el = document.getElementById('progress-pct');
  if (fill) fill.style.width = `${pct}%`;
  if (pct_el) pct_el.textContent  = `${pct}%`;
  if (currentComic) {
    currentComic.chapter = `Chapter ${currentChapter}`;
    const lr = document.getElementById('detail-last-read');
    if (lr) lr.textContent = `Last Read: Chapter ${currentChapter}`;
  }
}

function saveChapter() {
  if (!currentComic) return;
  fetch('/api/update_chapter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: currentComic.title, chapter: currentChapter })
  }).catch(e => console.error('update_chapter failed', e));

  const idx = ALL_COMICS.findIndex(c => c.title === currentComic.title);
  if (idx >= 0) {
    ALL_COMICS[idx].chapter = `Chapter ${currentChapter}`;
    const today  = new Date();
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const ds     = `${String(today.getDate()).padStart(2,'0')} ${MONTHS[today.getMonth()]} ${today.getFullYear()}`;
    ALL_COMICS[idx].date = ds;
    currentComic.date    = ds;
  }
}

function toggleFav() {
  if (!currentComic) return;
  currentComic.favorite = !currentComic.favorite;
  updateFavBtn();
  fetch('/api/toggle_favorite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: currentComic.title, isFav: currentComic.favorite })
  }).catch(e => console.error('toggle_favorite failed', e));
  const idx = ALL_COMICS.findIndex(c => c.title === currentComic.title);
  if (idx >= 0) ALL_COMICS[idx].favorite = currentComic.favorite;
}


// ── Helpers ───────────────────────────────────────────────────────────────────
function extractNum(s) {
  if (!s) return 0;
  const m = String(s).match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Explore Hub ───────────────────────────────────────────────────────────────
let exploreResults = {};
function toggleFilterPanel() {
  const panel = document.getElementById("filter-panel");
  if (panel) panel.classList.toggle("hidden");
}

function populateFilters() {
  const categories = new Set();
  const statuses = new Set();
  const genres = new Set();

  ALL_COMICS.forEach(c => {
    if (c.category) {
      const cat = c.category.trim();
      if (['Manga', 'Manhwa', 'Manhua'].includes(cat)) {
        categories.add(cat);
      }
    }
    if (c.status) {
      const st = c.status.trim();
      if (['Ongoing', 'Completed'].includes(st)) {
        statuses.add(st);
      }
    }
    if (c.genre) {
      c.genre.split(",").forEach(g => genres.add(g.trim()));
    }
  });

  renderFilterGroup("filter-types", categories, "categories");
  renderFilterGroup("filter-statuses", statuses, "statuses");
  renderFilterGroup("filter-genres", genres, "genres");
}

function renderFilterGroup(containerId, items, key) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";
  const sortedItems = [...items].sort();
  sortedItems.forEach(item => {
    if (!item) return;
    const div = document.createElement("div");
    div.className = "filter-opt" + (activeFilters[key].has(item) ? " active" : "");
    div.textContent = item;
    div.onclick = () => {
      if (activeFilters[key].has(item)) activeFilters[key].delete(item);
      else activeFilters[key].add(item);
      div.classList.toggle("active");
      renderDashboard();
    };
    container.appendChild(div);
  });
}

function clearFilters() {
  activeFilters.categories.clear();
  activeFilters.statuses.clear();
  activeFilters.genres.clear();
  document.querySelectorAll(".filter-opt").forEach(opt => opt.classList.remove("active"));
  renderDashboard();
}

function updateThemeIcon() {
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  const icon = document.getElementById("theme-icon");
  if (!icon) return;
  if (isLight) {
    // Moon
    icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path>`;
  } else {
    // Sun
    icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path>`;
  }
}

function toggleTheme() {
  const root = document.documentElement;
  const current = root.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", next);
  localStorage.setItem("manga_theme", next);
  updateThemeIcon();
}

// Ensure icon is correct on load
setTimeout(updateThemeIcon, 100);

async function saveNote() {
    if (!currentComic) return;
    const note = document.getElementById('detail-notes-input').value;
    try {
        const res = await fetch('/api/add_note', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ title: currentComic.title, note: note })
        });
        const data = await res.json();
        if (data.ok) {
            currentComic.Notes = note;
            currentComic.notes = note;
            document.getElementById('save-note-btn').style.display = 'none';
            // Also update the global ALL_COMICS array so we don't clear it on a quick close
            const mem = ALL_COMICS.find(c => norm(c.title) === norm(currentComic.title));
            if (mem) { mem.Notes = note; mem.notes = note; }
        } else {
            alert('Failed to save note.');
        }
    } catch (e) {
        console.error(e);
        alert('Failed to save note.');
    }
}

async function openStats() {
    document.getElementById('stats-modal').classList.remove('hidden');
    document.getElementById('heatmap-container').innerHTML = '<div class="spinner center"></div>';
    try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        renderHeatmap(data);
    } catch (e) {
        document.getElementById('heatmap-container').innerHTML = 'Failed to load stats.';
    }
}

function closeStats() {
    document.getElementById('stats-modal').classList.add('hidden');
}

function renderHeatmap(apiData) {
    const container = document.getElementById('heatmap-container');
    container.innerHTML = '';
    
    // Map data
    const counts = {};
    let totalRead = 0;
    apiData.forEach(d => {
        counts[d.date] = d.count;
        totalRead += d.count;
    });
    
    document.getElementById('heatmap-total').textContent = `${totalRead} chapters read in the last year`;

    // 52 weeks x 7 days
    const today = new Date();
    // Start exactly 52 weeks ago (364 days)
    const start = new Date(today.getTime() - 364 * 24 * 60 * 60 * 1000);
    // Align to Sunday
    start.setDate(start.getDate() - start.getDay());

    for (let w = 0; w < 53; w++) {
        const col = document.createElement('div');
        col.style.display = 'flex';
        col.style.flexDirection = 'column';
        col.style.gap = '4px';
        
        for (let d = 0; d < 7; d++) {
            const current = new Date(start.getTime() + (w * 7 + d) * 24 * 60 * 60 * 1000);
            if (current > today) break;
            
            const dateStr = current.toISOString().split('T')[0];
            const count = counts[dateStr] || 0;
            
            const cell = document.createElement('div');
            cell.style.width = '14px';
            cell.style.height = '14px';
            cell.style.borderRadius = '3px';
            cell.title = `${dateStr}: ${count} read`;
            
            if (count === 0) {
                cell.style.background = 'var(--bg3)';
            } else {
                cell.style.background = 'var(--accent)';
                if (count < 3) cell.style.opacity = '0.3';
                else if (count < 8) cell.style.opacity = '0.6';
                else if (count < 15) cell.style.opacity = '0.8';
                else cell.style.opacity = '1.0';
            }
            col.appendChild(cell);
        }
        container.appendChild(col);
    }
}

function updateNotifications() {
    const list = document.getElementById('notif-list');
    const badge = document.getElementById('notif-badge');
    if (!list || !badge) return;
    
    let unreadCount = 0;
    list.innerHTML = '';
    
    ALL_COMICS.forEach(c => {
        const cur = extractNum(c.chapter || '0');
        const lat = extractNum(c.latest_chapter || c['Latest Chapter'] || '0');
        if (lat > cur) {
            unreadCount++;
            const item = document.createElement('div');
            item.style.padding = '8px 16px';
            item.style.cursor = 'pointer';
            item.style.borderBottom = '1px solid var(--border)';
            item.style.fontSize = '0.85rem';
            item.innerHTML = `<strong style="display:block; margin-bottom:2px; color:var(--text);">${c.title || c.English}</strong><span style="color:var(--text2); font-size:0.75rem;">Chapter ${cur} → ${lat}</span>`;
            
            item.onmouseenter = () => item.style.background = 'var(--card-h)';
            item.onmouseleave = () => item.style.background = 'transparent';
            
            item.onclick = () => {
                document.getElementById('notif-dropdown').classList.add('hidden');
                showDetail(c);
            };
            list.appendChild(item);
        }
    });
    
    if (unreadCount > 0) {
        badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
        list.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text3); font-size:0.8rem;">You are up to date!</div>';
    }
}

function toggleNotifs() {
    document.getElementById('notif-dropdown').classList.toggle('hidden');
}

document.addEventListener('click', (e) => {
    const wrap = document.getElementById('notif-wrapper');
    if (wrap && !wrap.contains(e.target)) {
        const dd = document.getElementById('notif-dropdown');
        if (dd) dd.classList.add('hidden');
    }
});

// ── Offline Mode ─────────────────────────────────────────────────────────────
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

function updateOnlineStatus() {
    const banner = document.getElementById('offline-banner');
    if (banner) {
        if (!navigator.onLine) {
            banner.classList.remove('hidden');
        } else {
            banner.classList.add('hidden');
        }
    }
}
// Init check
updateOnlineStatus();
