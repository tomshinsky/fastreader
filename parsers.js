// Извлечение текста из TXT, EPUB и PDF. Результат — { title, sections },
// где title — название книги из её метаданных (если есть), а sections —
// список разделов [{ title, text }] с абзацами через пустую строку.

const Parsers = (() => {
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE',
    'TR', 'SECTION', 'ARTICLE', 'PRE', 'DT', 'DD', 'FIGCAPTION',
  ]);
  const MAX_TITLE = 60;

  async function parseFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    let book;
    if (ext === 'txt') book = await parseTxt(file);
    else if (ext === 'epub') book = await parseEpub(file);
    else if (ext === 'pdf') book = await parsePdf(file);
    else throw new Error('Поддерживаются только файлы TXT, EPUB и PDF');

    // Пустые разделы (обложки, картинки) выкидываем, безымянным подбираем название
    const sections = book.sections
      .filter((s) => /[\p{L}\p{N}]/u.test(s.text))
      .map((s, i) => ({ title: niceTitle(s.title || guessTitle(s.text)) || `Раздел ${i + 1}`, text: s.text }));
    return { title: book.title?.trim() || '', sections };
  }

  // Голый номер («IV», «12.») превращаем в «Глава IV»
  function niceTitle(title) {
    return /^([IVXLCDM]+|\d+)\.?$/i.test(title) ? `Глава ${title.replace(/\.$/, '')}` : title;
  }

  // Название по первой строке раздела, если она короткая
  function guessTitle(text) {
    const line = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
    return line.length <= MAX_TITLE ? line : '';
  }

  // ---------- TXT ----------

  const TXT_HEADING = /^\s*(?:глава|часть|книга|пролог|эпилог|chapter|part|prologue|epilogue)(?!\p{L}).{0,60}$/iu;

  // Пробуем UTF-8, при ошибках декодирования — Windows-1251
  async function parseTxt(file) {
    const buf = await file.arrayBuffer();
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder('windows-1251').decode(buf);
    }
    return { sections: splitTxtChapters(text, file.name) };
  }

  // Делим по строкам вида «Глава 5», «Часть вторая», «Chapter 3»
  function splitTxtChapters(text, fileName) {
    const sections = [{ title: '', lines: [] }];
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
      if (TXT_HEADING.test(line)) sections.push({ title: line.trim(), lines: [] });
      sections[sections.length - 1].lines.push(line);
    }
    if (sections.length < 3) return [{ title: fileName.replace(/\.[^.]+$/, ''), text }];
    return sections.map((s) => ({ title: s.title, text: s.lines.join('\n') }));
  }

  // ---------- EPUB ----------

  // Путь href относительно файла base, внутри архива
  function resolvePath(base, href) {
    const url = new URL(href, 'http://epub/' + base);
    return decodeURIComponent(url.pathname.slice(1));
  }

  async function parseEpub(file) {
    const zip = await JSZip.loadAsync(file);
    const read = (path) => {
      const entry = zip.file(path);
      if (!entry) throw new Error('Повреждённый EPUB: нет ' + path);
      return entry.async('string');
    };
    const xml = (str) => new DOMParser().parseFromString(str, 'application/xml');

    const container = xml(await read('META-INF/container.xml'));
    const opfPath = container.querySelector('rootfile').getAttribute('full-path');
    const opf = xml(await read(opfPath));

    const manifest = {};
    opf.querySelectorAll('manifest > item').forEach((item) => {
      manifest[item.getAttribute('id')] = {
        path: resolvePath(opfPath, item.getAttribute('href')),
        props: item.getAttribute('properties') || '',
      };
    });

    const titles = await readEpubToc(zip, opf, manifest);

    const sections = [];
    for (const ref of opf.querySelectorAll('spine > itemref')) {
      const item = manifest[ref.getAttribute('idref')];
      const entry = item && zip.file(item.path);
      if (!entry) continue;
      sections.push({ title: titles[item.path] || '', text: htmlToText(await entry.async('string')) });
    }
    const title = opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0]?.textContent;
    return { title, sections };
  }

  // Оглавление: { путь файла главы → название }. EPUB 3 — nav, EPUB 2 — toc.ncx
  async function readEpubToc(zip, opf, manifest) {
    const titles = {};
    const add = (base, href, label) => {
      const path = resolvePath(base, href.split('#')[0]);
      label = label.replace(/\s+/g, ' ').trim();
      if (label && !titles[path]) titles[path] = label;
    };
    try {
      const nav = Object.values(manifest).find((m) => m.props.split(/\s+/).includes('nav'));
      if (nav && zip.file(nav.path)) {
        const doc = parseChapter(await zip.file(nav.path).async('string'));
        const navs = [...doc.querySelectorAll('nav')];
        const toc = navs.find((n) => n.getAttribute('epub:type') === 'toc') || navs[0];
        toc?.querySelectorAll('a[href]').forEach((a) => add(nav.path, a.getAttribute('href'), a.textContent));
      }
      const ncxId = opf.querySelector('spine')?.getAttribute('toc');
      const ncx = manifest[ncxId];
      if (ncx && zip.file(ncx.path)) {
        const doc = new DOMParser().parseFromString(await zip.file(ncx.path).async('string'), 'application/xml');
        doc.querySelectorAll('navPoint').forEach((p) => {
          const label = p.querySelector(':scope > navLabel > text')?.textContent || '';
          const src = p.querySelector(':scope > content')?.getAttribute('src');
          if (src) add(ncx.path, src, label);
        });
      }
    } catch (err) {
      console.warn('Не удалось прочитать оглавление EPUB', err);
    }
    return titles;
  }

  // Главы EPUB — это XHTML. HTML-парсер ломается на конструкциях вроде <title/>
  // (считает тег открытым и «съедает» весь текст), поэтому сначала разбираем как XML.
  function parseChapter(html) {
    const parser = new DOMParser();
    const xdoc = parser.parseFromString(html, 'application/xhtml+xml');
    if (!xdoc.querySelector('parsererror') && xdoc.body) return xdoc;
    return parser.parseFromString(html, 'text/html');
  }

  function htmlToText(html) {
    const doc = parseChapter(html);
    doc.querySelectorAll('script, style, head').forEach((el) => el.remove());
    let out = '';
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toUpperCase(); // в XHTML имена тегов в нижнем регистре
      if (tag === 'BR') { out += '\n'; return; }
      const block = BLOCK_TAGS.has(tag);
      if (block) out += '\n\n';
      node.childNodes.forEach(walk);
      if (block) out += '\n\n';
    };
    if (doc.body) walk(doc.body);
    return out;
  }

  // ---------- PDF ----------

  async function parsePdf(file) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        text += item.str;
        if (item.hasEOL) text += '\n';
        else if (item.str && !item.str.endsWith(' ')) text += ' ';
      }
      pages.push(text);
    }

    const marks = await readPdfOutline(pdf);
    if (!marks.length || marks[0].page > 0) marks.unshift({ page: 0, title: '' });
    const info = await pdf.getMetadata().then((m) => m.info, () => ({}));
    const sections = marks.map((m, i) => ({
      title: m.title,
      // Склеиваем слова, перенесённые через дефис в конце строки
      text: pages.slice(m.page, marks[i + 1]?.page ?? pages.length).join('\n')
        .replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, '$1$2'),
    }));
    return { title: info?.Title, sections };
  }

  // Верхний уровень оглавления PDF → [{ page (с нуля), title }] по возрастанию страниц
  async function readPdfOutline(pdf) {
    const marks = [];
    try {
      for (const item of (await pdf.getOutline()) || []) {
        const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
        if (!dest) continue;
        const page = typeof dest[0] === 'object' ? await pdf.getPageIndex(dest[0]) : dest[0];
        if (Number.isInteger(page) && !marks.some((m) => m.page === page)) {
          marks.push({ page, title: item.title.trim() });
        }
      }
    } catch (err) {
      console.warn('Не удалось прочитать оглавление PDF', err);
    }
    return marks.sort((a, b) => a.page - b.page);
  }

  return { parseFile };
})();
