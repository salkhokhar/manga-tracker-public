function openExplore() {
  console.log('[EXPLORE] User clicked Explore button');
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('detail').classList.add('hidden');
  document.getElementById('reader').classList.add('hidden');
  document.getElementById('explore-view').classList.remove('hidden');
  updateExploreView();
}

function closeExplore() {
  console.log('[EXPLORE] User returned to Library');
  document.getElementById('explore-view').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('back-btn').classList.add('hidden');
}

async function updateExploreView() {
  const site    = document.getElementById('explore-site').value;
  const cat     = document.getElementById('explore-cat').value;
  const status  = document.getElementById('explore-status').value;
  const orderby = document.getElementById('explore-order').value;
  const grid    = document.getElementById('explore-grid');
  const spinner = document.getElementById('explore-spinner');

  console.log(`[EXPLORE] Refreshing: site=${site}, cat=${cat}, status=${status}, orderby=${orderby}`);

  grid.classList.add('hidden');
  spinner.classList.remove('hidden');

  const key = `${site}_${cat}_${status}_${orderby}`;
  explorePage[key] = 1;
  exploreResults[key] = null;
  await loadExplorePage(site, cat, status, orderby, 1, true);

  spinner.classList.add('hidden');
  grid.classList.remove('hidden');
}

async function loadExplorePage(site, cat, status, orderby, page, reset) {
  const grid = document.getElementById('explore-grid');
  const key  = `${site}_${cat}_${status}_${orderby}`;
  const oldBtn = document.getElementById('explore-load-more');
  if (oldBtn) oldBtn.remove();

  if (!exploreResults[key] || page > 1) {
    try {
      console.log(`[EXPLORE] Fetching page ${page} for site=${site}, cat=${cat}, status=${status}, orderby=${orderby}`);
      const res = await fetch(`/api/explore?site=${encodeURIComponent(site)}&category=${cat}&status=${status}&orderby=${orderby}&page=${page}`);
      const data = await res.json();
      console.log(`[EXPLORE] Received ${data.length} items from server`);
      if (page === 1) exploreResults[key] = data;
      else exploreResults[key] = (exploreResults[key] || []).concat(data);
    } catch(e) {
      console.error('[EXPLORE] Error fetching page:', e);
      if (page === 1) exploreResults[key] = [];
    }
  }

  const list = exploreResults[key] || [];
  if (reset) grid.innerHTML = '';
  const startIdx = reset ? 0 : grid.querySelectorAll('.card').length;
  const pageItems = list.slice(startIdx);

  if (list.length === 0 && reset) {
    grid.innerHTML = '<div style="padding:40px; color:var(--text3); grid-column: 1/-1; text-align:center;">No comics found in this category.</div>';
    return;
  }

  if (pageItems.length > 0) {
    const frag = document.createDocumentFragment();
    pageItems.forEach(c => frag.appendChild(buildCard(c, 'explore')));
    grid.appendChild(frag);
  }

  if (pageItems.length >= 12) {
    const loadMoreBtn = document.createElement('div');
    loadMoreBtn.id = 'explore-load-more';
    loadMoreBtn.className = 'explore-load-more-wrap';
    loadMoreBtn.innerHTML = `<button class="explore-load-more-btn" onclick="loadMoreExplore('${site}', '${cat}', '${status}', '${orderby}')">Load More</button>`;
    grid.appendChild(loadMoreBtn);
  }
}

async function loadMoreExplore(site, cat, status, orderby) {
  const key = `${site}_${cat}_${status}_${orderby}`;
  explorePage[key] = (explorePage[key] || 1) + 1;
  const btn = document.getElementById('explore-load-more');
  if (btn) btn.innerHTML = '<div class="spinner" style="width:28px;height:28px;margin:0 auto;"></div>';
  await loadExplorePage(site, cat, status, orderby, explorePage[key], false);
}

// ── Filters ──────────────────────────────────────────────────────────────────
