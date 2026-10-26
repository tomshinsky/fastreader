// RSVP-движок: показывает слова по одному, выравнивая по опорной букве.

const $ = (id) => document.getElementById(id);

const state = {
  book: null,       // { id, name, wordCount, openedAt }
  words: [],        // [{ text, pause, raw, paraEnd }]
  avgFactor: 1,     // средний множитель паузы по книге
  chapters: [],     // [{ title, start }] — start это индекс первого слова главы
  chapter: -1,      // текущая глава
  index: 0,
  playing: false,
  timer: null,
  dueAt: 0,         // когда по плану должно смениться текущее слово (performance.now)
  wpm: 300,
  warmup: 0,        // сколько слов после старта ещё показываются замедленно
  breakMs: 20 * 60000,  // напоминать о перерыве через столько чтения (0 — не напоминать)
  readMs: 0,        // сколько читаем без перерыва (без текущего запуска)
  playStartedAt: 0,
  pausedAt: -Infinity,
};

const MIN_WPM = 100;
const MAX_WPM = 1200;
const WPM_STEP = 25;
const CONTEXT_CHUNK = 400;      // сколько слов текста дорисовывать за раз
const CONTEXT_EDGE_PX = 400;    // за сколько пикселей до края текста подгружать ещё
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
      w.paraEnd = i === parts.length - 1;
      w.pause = pauseFactor(w.text, w.paraEnd, parts[i + 1]?.text);
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

// ---------- Текст на паузе ----------
// Показываем кусок книги вокруг текущего слова, с абзацами и заголовками глав.
// При прокрутке к краю дорисовываем ещё — так можно листать сколько угодно,
// не создавая сразу сотни тысяч элементов.

const view = { from: 0, to: 0 };  // какие слова сейчас нарисованы: [from, to)

function paragraphStart(i) {
  i = Math.max(0, Math.min(i, state.words.length - 1));
  while (i > 0 && !state.words[i - 1].paraEnd) i--;
  return i;
}

function paragraphEnd(i) {
  i = Math.max(0, Math.min(i, state.words.length - 1));
  while (i < state.words.length - 1 && !state.words[i].paraEnd) i++;
  return i + 1;
}

function buildText(from, to) {
  const frag = document.createDocumentFragment();
  const starts = new Map(state.chapters.map((c) => [c.start, c.title]));
  let p = null;
  for (let i = from; i < to; i++) {
    if (starts.has(i) && state.chapters.length > 1) {
      const h = document.createElement('h3');
      h.textContent = starts.get(i);
      frag.append(h);
    }
    if (!p) {
      p = document.createElement('p');
      frag.append(p);
    }
    const span = document.createElement('span');
    span.textContent = state.words[i].text;
    span.dataset.i = i;
    if (i === state.index) span.className = 'current';
    p.append(span, ' ');
    if (state.words[i].paraEnd) p = null;
  }
  return frag;
}

function renderContext() {
  const tv = $('textview');
  $('reader').classList.toggle('is-playing', state.playing);
  if (state.playing || !state.words.length) { tv.hidden = true; return; }

  const box = $('context');
  const fresh = tv.hidden || state.index < view.from || state.index >= view.to;
  tv.hidden = false;
  if (fresh) {
    view.from = paragraphStart(state.index - CONTEXT_CHUNK);
    view.to = paragraphEnd(state.index + CONTEXT_CHUNK);
    box.replaceChildren(buildText(view.from, view.to));
  } else {
    box.querySelector('.current')?.classList.remove('current');
    box.querySelector(`[data-i="${state.index}"]`)?.classList.add('current');
  }
  scrollToCurrent(fresh ? 'center' : 'nearest');
}

// Прокручиваем только сам блок текста, не всю страницу
function scrollToCurrent(mode) {
  const box = $('context');
  const el = box.querySelector('.current');
  if (!el) return;
  const top = el.offsetTop;  // .context спозиционирован, отсчёт идёт от него
  if (mode === 'center') {
    box.scrollTop = top - box.clientHeight / 2;
  } else if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - el.offsetHeight) {
    box.scrollTop = top - box.clientHeight / 3;
  }
}

function extendContext() {
  const box = $('context');
  if (box.scrollTop < CONTEXT_EDGE_PX && view.from > 0) {
    const from = paragraphStart(view.from - CONTEXT_CHUNK);
    const before = box.scrollHeight;
    box.prepend(buildText(from, view.from));
    box.scrollTop += box.scrollHeight - before;  // текст не должен «прыгнуть»
    view.from = from;
  }
  if (box.scrollHeight - box.scrollTop - box.clientHeight < CONTEXT_EDGE_PX && view.to < state.words.length) {
    const to = paragraphEnd(view.to + CONTEXT_CHUNK);
    box.append(buildText(view.to, to));
    view.to = to;
  }
}

// ---------- Поиск места по фразе ----------
// Сравниваем без регистра, знаков препинания и разницы «е/ё».

const search = { book: null, text: '', offsets: [] };

function normalize(s) {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function buildSearchIndex() {
  if (search.book === state.book) return;
  const parts = [];
  const offsets = [];
  let pos = 0;
  for (const w of state.words) {
    const n = normalize(w.text);
    offsets.push(pos);
    parts.push(n);
    pos += n.length + 1;
  }
  search.book = state.book;
  search.text = parts.join(' ');
  search.offsets = offsets;
}

function wordAtOffset(offset) {
  let lo = 0;
  let hi = search.offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (search.offsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Ищем после текущего слова, а дойдя до конца книги — с начала
function findPhrase(query) {
  const q = normalize(query);
  if (!q) return;
  buildSearchIndex();
  const from = (search.offsets[state.index + 1] ?? search.text.length);
  let at = search.text.indexOf(q, from);
  const wrapped = at < 0;
  if (wrapped) at = search.text.indexOf(q);
  const status = $('findStatus');
  status.hidden = false;
  if (at < 0) {
    status.textContent = 'Не нашёл такую фразу';
    return;
  }
  const first = wordAtOffset(at);
  const last = wordAtOffset(at + q.length - 1);
  $('context').querySelectorAll('.found').forEach((el) => el.classList.remove('found'));
  jumpTo(first);
  for (let i = first; i <= last; i++) $('context').querySelector(`[data-i="${i}"]`)?.classList.add('found');
  const c = state.chapters[chapterAt(first)];
  status.textContent = (wrapped ? 'Дошёл до конца и начал сначала. ' : '')
    + (state.chapters.length > 1 ? `Нашёл: ${c.title}. ` : 'Нашёл. ')
    + 'Ещё раз «Найти» — следующее совпадение.';
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
    if (breakDue(state.index)) { takeBreak(); return; }
    state.index++;
    tick();
  }, Math.max(0, state.dueAt - now));
}

// ---------- Перерывы ----------
// Считаем время непрерывного чтения. Когда подходит срок, останавливаемся
// в конце главы, а если до него далеко или глав нет — в конце абзаца.
// Пауза дольше REST_MS считается отдыхом и обнуляет счётчик.

const BREAK_LOOKAHEAD_MS = 3 * 60000;  // насколько готовы дочитать до конца главы
const REST_MS = 2 * 60000;

function readingMs() {
  return state.readMs + (state.playing ? performance.now() - state.playStartedAt : 0);
}

function breakDue(i) {
  if (!state.breakMs) return false;
  const w = state.words[i];
  if (!w.paraEnd) return false;
  const elapsed = readingMs();
  const end = chapterEnd(chapterAt(i));
  const isChapterEnd = i === end - 1;
  // Конец главы незадолго до срока — хорошее место, не начинаем новую главу
  if (isChapterEnd) return elapsed >= state.breakMs - BREAK_LOOKAHEAD_MS;
  if (elapsed < state.breakMs) return false;
  // Срок вышел: если до конца главы недалеко — дочитываем, иначе стоп на этом абзаце
  const msToChapterEnd = (end - 1 - i) * 60000 / state.wpm;
  return msToChapterEnd > BREAK_LOOKAHEAD_MS;
}

function takeBreak() {
  const minutes = Math.max(1, Math.round(readingMs() / 60000));
  state.index++;  // продолжим с начала следующего абзаца
  pause();
  state.readMs = 0;
  $('breakText').textContent = `Вы читаете ${minutes} мин без перерыва. Дайте глазам отдохнуть: посмотрите вдаль, поморгайте.`;
  showBreakNotice(true);
}

function showBreakNotice(show) {
  $('breakNotice').hidden = !show;
  $('reader').classList.toggle('on-break', show);
}

function setBreakMinutes(min) {
  state.breakMs = min * 60000;
  store.set('fr:break', min);
}

function play() {
  if (!state.words.length || state.playing) return;
  if (state.index >= state.words.length - 1) state.index = 0;
  const now = performance.now();
  if (now - state.pausedAt > REST_MS) state.readMs = 0;
  showBreakNotice(false);
  state.playStartedAt = now;
  state.playing = true;
  state.warmup = 4;
  $('playBtn').textContent = '❚❚';
  renderContext();
  tick(true);
}

function pause() {
  if (state.playing) {
    state.readMs += performance.now() - state.playStartedAt;
    state.pausedAt = performance.now();
  }
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
  view.from = view.to = 0;  // текст на паузе — от новой книги
  showBreakNotice(false);
  $('findStatus').hidden = true;
  $('findInput').value = '';
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

// Образец, чтобы было что попробовать сразу. Кладётся в библиотеку один раз
// (в том числе тем, у кого уже есть книги); удалённый — не возвращается.
const SAMPLE = {
  id: 'sample:twelve-chairs-12',
  url: 'samples/twelve-chairs-12.txt',
  name: 'twelve-chairs-12.txt',
  title: 'Двенадцать стульев, Ильф и Петров: Глава XII',
  chapter: 'Глава XII. Знойная женщина — мечта поэта',
};

async function seedSample() {
  if (store.get('fr:sampleSeeded')) return;
  try {
    const res = await fetch(SAMPLE.url);
    if (!res.ok) return;
    const sections = [{ title: SAMPLE.chapter, text: await res.text() }];
    const { rawCount } = buildBook(sections);
    await Library.save({ id: SAMPLE.id, name: SAMPLE.name, title: SAMPLE.title, wordCount: rawCount, openedAt: 0 }, sections);
    store.set('fr:sampleSeeded', true);
  } catch (err) {
    console.warn('Не удалось добавить образец', err);
  }
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
$('context').addEventListener('scroll', extendContext, { passive: true });
$('findForm').addEventListener('submit', (e) => {
  e.preventDefault();
  findPhrase($('findInput').value);
});
$('breakNotice').addEventListener('click', (e) => e.stopPropagation());
$('breakContinueBtn').addEventListener('click', play);
$('breakSelect').addEventListener('change', (e) => setBreakMinutes(Number(e.target.value)));

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
const savedBreak = store.get('fr:break');
if (Number.isInteger(savedBreak)) state.breakMs = savedBreak * 60000;
$('breakSelect').value = String(state.breakMs / 60000);

// Сразу открываем книгу, которую читали в прошлый раз
const lastId = store.get('fr:last');
seedSample().then(() => {
  if (lastId) openFromLibrary(lastId);
  else renderLibrary();
});
