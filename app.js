// RSVP-движок: показывает слова по одному, выравнивая по опорной букве.

const $ = (id) => document.getElementById(id);

const state = {
  book: null,       // { id, name, wordCount, openedAt }
  words: [],        // [{ text, pause, raw }]
  avgFactor: 1,     // средний множитель паузы по книге
  chapters: [],     // [{ title, start }] — start это индекс первого слова главы
  chapter: -1,      // текущая глава
  index: 0,
  playing: false,
  timer: null,
  dueAt: 0,         // когда по плану должно смениться текущее слово (performance.now)
  wpm: 300,
  warmup: 0,        // сколько слов после старта ещё показываются замедленно
};

const MIN_WPM = 100;
const MAX_WPM = 1200;
const WPM_STEP = 25;
const CONTEXT_RADIUS = 40;
const MAX_LATE_MS = 250;

const posKey = (id) => `fr:pos:${id}`;

// ---------- Разбор текста на слова ----------

// Добавки к базовому времени слова. Берётся одна, самая сильная, — без сложения
const PAUSE = { paragraph: 1, sentence: 0.6, clause: 0.25 };
const LENGTH_BONUS = 0.04;   // за каждую букву после шестой
const MAX_FACTOR = 2;        // ни одно слово не держится дольше двух обычных

const SENTENCE_END = /[.!?…]["»”)]*$/;
const CLAUSE_END = /[,;:—–]["»”)]*$/;
const HAS_LETTERS = /[\p{L}\p{N}]/u;
const DASH = /^[—–-]+$/;

// Слово хранит raw — номер исходного «куска через пробел». Он не зависит
// от правил склейки, поэтому место чтения сохраняется именно в нём.
function tokenize(text, rawStart) {
  const words = [];
  let raw = rawStart;
  for (const para of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const parts = joinPunctuation(para.split(/\s+/).filter(Boolean).map((t) => ({ text: t, raw: raw++ })));
    parts.forEach((w, i) => {
      w.pause = pauseFactor(w.text, i === parts.length - 1, parts[i + 1]?.text);
      words.push(w);
    });
  }
  return { words, rawCount: raw - rawStart };
}

// Одиночное тире приклеиваем к следующему слову («— Тут»), висящую пунктуацию —
// к предыдущему, а знаки без смысла (звёздочки, разделители) пропускаем
function joinPunctuation(tokens) {
  const out = [];
  let dash = null;
  for (const t of tokens) {
    if (HAS_LETTERS.test(t.text)) {
      out.push(dash ? { text: `${dash.text} ${t.text}`, raw: dash.raw } : t);
      dash = null;
    } else if (DASH.test(t.text)) {
      dash = dash ? { text: `${dash.text} ${t.text}`, raw: dash.raw } : t;
    } else if (/[.!?…,;:]/.test(t.text) && out.length) {
      out[out.length - 1].text += t.text;
    }
  }
  if (dash && out.length) out[out.length - 1].text += ` ${dash.text}`;
  return out;
}

function pauseFactor(word, paragraphEnd, nextWord = '') {
  let pause = 0;
  if (paragraphEnd) pause = PAUSE.paragraph;
  else if (SENTENCE_END.test(word)) pause = PAUSE.sentence;
  else if (CLAUSE_END.test(word) || /^[—–]/.test(nextWord)) pause = PAUSE.clause;
  const letters = word.match(/[\p{L}\p{N}]/gu)?.length || 0;
  const length = Math.max(0, letters - 6) * LENGTH_BONUS;
  return Math.min(1 + pause + length, MAX_FACTOR);
}

function buildBook(sections) {
  const words = [];
  const chapters = [];
  let rawCount = 0;
  for (const s of sections) {
    const part = tokenize(s.text, rawCount);
    rawCount += part.rawCount;
    if (!part.words.length) continue;
    chapters.push({ title: s.title, start: words.length });
    for (const w of part.words) words.push(w);
  }
  // Средний множитель — чтобы выбранная скорость была реальной средней скоростью
  const avgFactor = words.reduce((sum, w) => sum + w.pause, 0) / (words.length || 1);
  return { words, chapters, rawCount, avgFactor };
}

// Первое слово, которое начинается с исходного куска raw или позже
function indexOfRaw(raw) {
  let lo = 0;
  let hi = state.words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (state.words[mid].raw < raw) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Опорная точка распознавания (ORP) — чуть левее центра слова
function pivotIndex(word) {
  const letters = word.replace(/^[^\p{L}\p{N}]+/u, '');
  const lead = word.length - letters.length;
  const n = letters.replace(/[^\p{L}\p{N}]+$/u, '').length;
  let p;
  if (n <= 1) p = 0;
  else if (n <= 5) p = 1;
  else if (n <= 9) p = 2;
  else if (n <= 13) p = 3;
  else p = 4;
  return Math.min(lead + p, word.length - 1);
}

function isSentenceEnd(i) {
  return i >= 0 && /[.!?…]["»”)]*$/.test(state.words[i].text);
}

function chapterAt(index) {
  let lo = 0;
  let hi = state.chapters.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (state.chapters[mid].start <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function chapterEnd(c) {
  return state.chapters[c + 1]?.start ?? state.words.length;
}

// ---------- Отображение ----------

function formatMinutes(min) {
  return min >= 60 ? `${Math.floor(min / 60)} ч ${min % 60} мин` : `${min} мин`;
}

function renderWord() {
  const w = state.words[state.index];
  if (!w) return;
  const p = pivotIndex(w.text);
  $('wLeft').textContent = w.text.slice(0, p);
  $('wPivot').textContent = w.text[p];
  $('wRight').textContent = w.text.slice(p + 1);
  renderProgress();
}

function renderProgress() {
  const total = state.words.length;
  $('seek').max = Math.max(total - 1, 0);
  $('seek').value = state.index;
  $('posInfo').textContent = `${(state.index + 1).toLocaleString('ru')} / ${total.toLocaleString('ru')}`;
  $('timeInfo').textContent = `книга ≈ ${formatMinutes(Math.ceil((total - state.index) / state.wpm))}`;

  const c = chapterAt(state.index);
  if (c !== state.chapter) {
    state.chapter = c;
    $('chapterSelect').value = c;
    $('nextChapterBtn').disabled = c >= state.chapters.length - 1;
  }
  $('chapterTimeInfo').textContent = state.chapters.length > 1
    ? `глава ≈ ${formatMinutes(Math.ceil((chapterEnd(c) - state.index) / state.wpm))}`
    : '';
}

function renderChapters() {
  const select = $('chapterSelect');
  select.replaceChildren(...state.chapters.map((ch, i) => new Option(ch.title, i)));
  select.closest('.chapters').hidden = state.chapters.length < 2;
  state.chapter = -1;
}

function renderContext() {
  const box = $('context');
  if (state.playing || !state.words.length) { box.hidden = true; return; }
  const from = Math.max(0, state.index - CONTEXT_RADIUS);
  const to = Math.min(state.words.length, state.index + CONTEXT_RADIUS);
  box.replaceChildren();
  for (let i = from; i < to; i++) {
    const span = document.createElement('span');
    span.textContent = state.words[i].text;
    span.dataset.i = i;
    if (i === state.index) span.className = 'current';
    box.append(span, ' ');
  }
  box.hidden = false;
  box.querySelector('.current')?.scrollIntoView({ block: 'center' });
}

function renderWpm() {
  $('wpmVal').textContent = state.wpm;
}

// ---------- Воспроизведение ----------

function delayFor(word) {
  let ms = (60000 / state.wpm / state.avgFactor) * word.pause;
  if (state.warmup > 0) {
    ms *= 1 + state.warmup * 0.15;
    state.warmup--;
  }
  return ms;
}

// Время смены слова считаем от запланированного момента, а не от фактического
// срабатывания таймера, — так опоздания таймера не накапливаются.
// Перед запуском новой цепочки старая всегда гасится: двух таймеров быть не может.
function tick(restart = false) {
  clearTimeout(state.timer);
  const now = performance.now();
  // После сна телефона или фоновой вкладки не «догоняем» пропущенное пачкой слов
  if (restart || now - state.dueAt > MAX_LATE_MS) state.dueAt = now;
  renderWord();
  saveProgress();
  state.dueAt += delayFor(state.words[state.index]);
  state.timer = setTimeout(() => {
    if (state.index >= state.words.length - 1) { pause(); return; }
    state.index++;
    tick();
  }, Math.max(0, state.dueAt - now));
}

function play() {
  if (!state.words.length || state.playing) return;
  if (state.index >= state.words.length - 1) state.index = 0;
  state.playing = true;
  state.warmup = 4;
  $('playBtn').textContent = '❚❚';
  renderContext();
  tick(true);
}

function pause() {
  state.playing = false;
  clearTimeout(state.timer);
  $('playBtn').textContent = '▶';
  renderWord();
  renderContext();
  saveProgress();
}

function toggle() {
  state.playing ? pause() : play();
}

function jumpTo(i) {
  state.index = Math.max(0, Math.min(i, state.words.length - 1));
  if (state.playing) { state.warmup = 4; tick(true); }
  else { renderWord(); renderContext(); saveProgress(); }
}

function prevSentence() {
  let i = state.index - 1;
  // Если стоим в начале предложения — переходим к началу предыдущего
  while (i > 0 && !isSentenceEnd(i - 1)) i--;
  jumpTo(i);
}

function nextSentence() {
  let i = state.index;
  while (i < state.words.length - 1 && !isSentenceEnd(i)) i++;
  jumpTo(i + 1);
}

// Как в плеере: если глава уже начата — в её начало, иначе — в предыдущую
function prevChapter() {
  const c = chapterAt(state.index);
  const start = state.chapters[c].start;
  jumpTo(state.index > start || c === 0 ? start : state.chapters[c - 1].start);
}

function nextChapter() {
  const c = chapterAt(state.index);
  if (c < state.chapters.length - 1) jumpTo(state.chapters[c + 1].start);
}

function changeWpm(delta) {
  state.wpm = Math.max(MIN_WPM, Math.min(MAX_WPM, state.wpm + delta));
  store.set('fr:wpm', state.wpm);
  renderWpm();
  renderProgress();
}

function saveProgress() {
  const w = state.words[state.index];
  if (state.book && w) store.set(posKey(state.book.id), w.raw);
}

// ---------- Книги ----------

function bookTitle(meta) {
  return meta.title || meta.name.replace(/\.[^.]+$/, '');
}

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

async function loadFile(file) {
  if (!file) return;
  pause();
  setStatus('Читаю файл…');
  try {
    const { title, sections } = await Parsers.parseFile(file);
    const { words, rawCount } = buildBook(sections);
    if (!words.length) throw new Error('В файле не найден текст (возможно, это скан без текстового слоя)');
    // wordCount считаем в исходных кусках — в тех же единицах, что и сохранённая позиция
    const meta = { id: `${file.name}:${file.size}`, name: file.name, title, wordCount: rawCount, openedAt: Date.now() };
    try {
      await Library.save(meta, sections);
    } catch (err) {
      console.warn('Не удалось сохранить книгу в библиотеку', err);
    }
    setStatus('');
    openBook(meta, sections);
  } catch (err) {
    console.error(err);
    const message = err.message || 'Не удалось прочитать файл';
    setStatus(message, true);
    // Если файл открывали из читалки, строка статуса не видна
    if ($('library').hidden) alert(message);
  }
}

function openBook(meta, sections) {
  pause();
  const { words, chapters, avgFactor } = buildBook(sections);
  state.book = meta;
  state.words = words;
  state.chapters = chapters;
  state.avgFactor = avgFactor;
  const saved = store.get(posKey(meta.id));
  state.index = Number.isInteger(saved) ? indexOfRaw(saved) : 0;
  store.set('fr:last', meta.id);

  $('fileName').textContent = bookTitle(meta);
  $('libraryBtn').hidden = false;
  $('library').hidden = true;
  $('reader').hidden = false;
  renderChapters();
  renderWord();
  renderContext();

  meta.openedAt = Date.now();
  Library.touch(meta).catch(() => {});
}

async function openFromLibrary(id) {
  setStatus('Открываю…');
  try {
    const [books, sections] = await Promise.all([Library.list(), Library.getSections(id)]);
    const meta = books.find((b) => b.id === id);
    if (!meta || !sections) throw new Error('Книга не найдена в библиотеке');
    setStatus('');
    openBook(meta, sections);
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Не удалось открыть книгу', true);
    showLibrary();
  }
}

async function showLibrary() {
  pause();
  state.book = null;
  store.remove('fr:last');
  $('fileName').textContent = '';
  $('libraryBtn').hidden = true;
  $('reader').hidden = true;
  $('library').hidden = false;
  await renderLibrary();
}

async function renderLibrary() {
  let books = [];
  try { books = await Library.list(); } catch { /* библиотека недоступна */ }
  books.sort((a, b) => b.openedAt - a.openedAt);
  const list = $('booksList');
  list.replaceChildren(...books.map((b) => {
    const pos = store.get(posKey(b.id)) || 0;
    const percent = b.wordCount > 1 ? Math.round((pos / (b.wordCount - 1)) * 100) : 0;
    const li = document.createElement('li');
    li.innerHTML = `
      <button type="button" class="book-open">
        <span class="book-name"></span>
        <span class="book-percent">${percent}%</span>
        <span class="book-progress"><span style="width:${percent}%"></span></span>
      </button>
      <button type="button" class="book-remove" title="Удалить из библиотеки">×</button>`;
    li.querySelector('.book-name').textContent = bookTitle(b);
    li.querySelector('.book-open').addEventListener('click', () => openFromLibrary(b.id));
    li.querySelector('.book-remove').addEventListener('click', async () => {
      if (!confirm(`Удалить «${bookTitle(b)}» из библиотеки?`)) return;
      await Library.remove(b.id).catch(() => {});
      store.remove(posKey(b.id));
      renderLibrary();
    });
    return li;
  }));
  $('booksBlock').hidden = !books.length;
}

// ---------- События ----------

function openPicker() { $('fileInput').click(); }

$('openBtn').addEventListener('click', openPicker);
$('pickBtn').addEventListener('click', openPicker);
$('libraryBtn').addEventListener('click', showLibrary);
$('fileInput').addEventListener('change', (e) => {
  loadFile(e.target.files[0]);
  e.target.value = '';
});

// Перетаскивание работает по всему окну, не только по рамке
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  $('dropzone').classList.add('over');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').classList.remove('over'); }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').classList.remove('over');
  loadFile(e.dataTransfer.files[0]);
});

$('playBtn').addEventListener('click', toggle);
$('stage').addEventListener('click', toggle);
$('backBtn').addEventListener('click', prevSentence);
$('fwdBtn').addEventListener('click', nextSentence);
$('prevChapterBtn').addEventListener('click', prevChapter);
$('nextChapterBtn').addEventListener('click', nextChapter);
$('chapterSelect').addEventListener('change', (e) => {
  jumpTo(state.chapters[Number(e.target.value)].start);
  e.target.blur();
});
$('slowerBtn').addEventListener('click', () => changeWpm(-WPM_STEP));
$('fasterBtn').addEventListener('click', () => changeWpm(WPM_STEP));
$('seek').addEventListener('input', (e) => jumpTo(Number(e.target.value)));
$('context').addEventListener('click', (e) => {
  const i = e.target.dataset?.i;
  if (i !== undefined) jumpTo(Number(i));
});

document.addEventListener('keydown', (e) => {
  if (!state.book || e.target.tagName === 'SELECT' || (e.target.tagName === 'INPUT' && e.target.type !== 'range')) return;
  const actions = {
    ' ': toggle,
    ArrowLeft: prevSentence,
    ArrowRight: nextSentence,
    ArrowUp: () => changeWpm(WPM_STEP),
    ArrowDown: () => changeWpm(-WPM_STEP),
    PageUp: prevChapter,
    PageDown: nextChapter,
  };
  const action = actions[e.key];
  if (action) { e.preventDefault(); action(); }
});

// ---------- Запуск ----------

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// Просим браузер не удалять библиотеку при нехватке места
navigator.storage?.persist?.().catch(() => {});

state.wpm = store.get('fr:wpm') || state.wpm;
renderWpm();

// Сразу открываем книгу, которую читали в прошлый раз
const lastId = store.get('fr:last');
if (lastId) openFromLibrary(lastId);
else renderLibrary();
