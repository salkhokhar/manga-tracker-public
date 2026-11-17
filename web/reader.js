function renderChapterList(chaps) {
  currentChapters = chaps;
  const cList = document.getElementById('chapter-list');
  if (!cList) return;
  cList.innerHTML = '';
  if (!chaps || chaps.length === 0) {
     cList.innerHTML = '<div style="padding:12px;color:var(--text3);">No chapters found online.</div>';
     return;
  }
  chaps.forEach((ch, idx) => {
    const row = document.createElement('div');
    row.className = 'chapter-row';
    row.onclick = () => openReader(idx);
    row.innerHTML = `
      <div class="chapter-name">${escHtml(ch.name)}</div>
      <div class="chapter-date">${escHtml(ch.date)}</div>
    `;
    cList.appendChild(row);
  });
}

async function openReader(idx) {
  if (idx < 0 || idx >= currentChapters.length) return;
  currentChapterIdx = idx;
  const ch = currentChapters[idx];
  
  document.getElementById('detail').classList.add('hidden');
  const reader = document.getElementById('reader');
  reader.classList.remove('hidden');
  
  document.getElementById('reader-title').textContent = ch.name;
  document.getElementById('reader-prev').disabled = (idx >= currentChapters.length - 1);
  document.getElementById('reader-next').disabled = (idx <= 0);
  
  const content = document.getElementById('reader-content');
  content.innerHTML = '<div class="spinner center" style="margin:60px auto;"></div>';
  content.scrollTop = 0;
  document.getElementById('reader-floating-bar').classList.remove('hidden-bar');
  
  try {
     const res = await fetch(`/api/chapter_images?url=${encodeURIComponent(ch.url)}`);
     const images = await res.json();
     content.innerHTML = '';
     if (images && images.length > 0) {
        images.forEach(src => {
           content.innerHTML += `<img class="reader-img" src="${escHtml(src)}" loading="lazy" />`;
        });
     } else {
        content.innerHTML = '<div style="padding:40px; color:#ccc;">No images found for this chapter.</div>';
     }

     if (currentComic && !currentComic.isOnlineOnly) {
         const num = extractNum(ch.name);
         if (num > currentChapter) {
             currentChapter = num;
             document.getElementById('chapter-input').value = num;
             saveChapter();
             refreshProgress();
         }
     }
  } catch (e) {
     console.error(e);
     content.innerHTML = '<div style="padding:40px; color:red;">Failed to load images.</div>';
  }
}

function closeReader() {
  document.getElementById('reader').classList.add('hidden');
  document.getElementById('reader-content').innerHTML = '';
  document.getElementById('detail').classList.remove('hidden');
}

function prevReaderChapter() { openReader(currentChapterIdx + 1); }
function nextReaderChapter() { openReader(currentChapterIdx - 1); }

let currentZoom = 1.0;
const defaultImgWidth = 800;

function changeZoom(delta) {
  currentZoom = Math.max(0.4, Math.min(3.0, currentZoom + delta));
  const newWidth = Math.floor(defaultImgWidth * currentZoom);
  document.documentElement.style.setProperty('--zoom', `${newWidth}px`);
}

let lastScrollY = 0;
const readerContent = document.getElementById('reader-content');
if (readerContent) {
  readerContent.addEventListener('scroll', (e) => {
    const currentY = e.target.scrollTop;
    const bar = document.getElementById('reader-floating-bar');
    if (currentY > lastScrollY && currentY > 100) {
       bar.classList.add('hidden-bar');
    } else {
       bar.classList.remove('hidden-bar');
    }
    lastScrollY = currentY;
  });
}

document.getElementById('reader').addEventListener('mousemove', (e) => {
   if (window.innerHeight - e.clientY < 120) {
      document.getElementById('reader-floating-bar').classList.remove('hidden-bar');
   }
});

