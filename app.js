const $ = id => document.getElementById(id);
const status = message => {
  $('status').textContent = message;
  $('status').style.cssText = 'position:sticky;top:0;z-index:20;background:#fff3cf;padding:10px;white-space:pre-wrap';
};
const canvas = $('canvas');
const selected = new Set();
let bundled = {sources:[],entries:[],report:[]};
let db, pdfjs, activePdf, currentPage = 1, base, crop, start, parts = [];
let data = { sources: [], entries: [] };

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function save(nextData) {
  const transaction = db.transaction('data', 'readwrite');
  const finished = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
  transaction.objectStore('data').put(nextData, 'catalog');
  await finished;
  data = nextData;
}

function options(id, choices) {
  const select = $(id);
  const oldValue = select.value;
  select.replaceChildren(...choices.map(([value, label]) => new Option(label, value)));
  if (choices.some(([value]) => String(value) === oldValue)) select.value = oldValue;
}

function updateList() {
  const tags = [...new Set(data.entries.flatMap(item => item.tags))].sort();
  const years = [...new Set(data.sources.map(source => source.year))].sort((a,b) => b-a);
  options('yearFilter', [['', '全年度'], ...years.map(year => [year, year + '年度'])]);
  options('tagFilter', [['', '全単元'], ...tags.map(tag => [tag, tag])]);
  const filtered = data.entries.filter(item => {
    const source = data.sources.find(source => source.id === item.source);
    return (!$('yearFilter').value || +$('yearFilter').value === source.year)
      && (!$('tagFilter').value || item.tags.includes($('tagFilter').value));
  });
  $('results').replaceChildren();
  if (!filtered.length) $('results').append(Object.assign(document.createElement('li'), {textContent:'該当する登録済みの問題はありません。'}));
  for (const item of filtered) {
    const source = data.sources.find(source => source.id === item.source);
    const row = document.createElement('li');
    const label = document.createElement('label');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.disabled = !!item.incomplete;
    check.checked = selected.has(item.id);
    check.onchange = () => {
      if (check.checked) selected.add(item.id);
      else selected.delete(item.id);
      updateButtons();
    };
    label.append(check, ' ' + source.year + '年度 ' + item.number + ' ／ ' + item.tags.join('・') + (item.incomplete ? '【9ページ欠落・印刷不可】' : ''));
    const preview = document.createElement('button');
    preview.textContent = '問題を見る';
    preview.onclick = () => run(preview, async () => {
      $('source').value = source.id;
      await changeSource();
      await showPage(item.parts[0].page);
      $('editor').open = true;
      $('editor').scrollIntoView({behavior:'smooth'});
    });
    const edit = document.createElement('button');
    edit.textContent = '編集';
    edit.onclick = () => run(edit, async () => {
      const tagText = prompt('単元（読点区切り）', item.tags.join('、'));
      if (tagText === null) return;
      const tags = parseTags(tagText);
      if (!tags.length) throw new Error('単元を入力してください。');
      const answer = prompt('正答', item.answer);
      if (answer === null) return;
      await save({...data, entries:data.entries.map(entry => entry.id === item.id ? {...item,tags,answer:answer.trim()} : entry)});
      updateList();
    });
    row.append(label, preview, edit);
    $('results').append(row);
  }
  updateButtons();
}

function updateButtons() {
  $('questions').disabled = $('answers').disabled = !selected.size;
  $('questions').textContent = '選んだ問題をA4印刷（' + selected.size + '問）';
}

function parseTags(value) {
  return [...new Set(value.split(/[、,，]/).map(tag => tag.trim()).filter(Boolean))];
}

async function openPdf(bytes) {
  if (!pdfjs) {
    pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  }
  return pdfjs.getDocument({data:bytes.slice(0)}).promise;
}

async function openSource(source) {
  if (source.pages) return {pages:source.pages,numPages:source.pages.length,destroy:async () => {}};
  if (source.path) {
    const response = await fetch(source.path);
    if (!response.ok) throw new Error('資料を読み込めません。ZIP内のassetsフォルダーも配置してください。');
    return openPdf(await response.arrayBuffer());
  }
  return openPdf(source.bytes);
}

async function renderPage(pdf, pageNumber, scale) {
  if (pdf.pages) {
    if (pdf.pages[pageNumber-1].missing) {
      const output = document.createElement('canvas');
      output.width = 1000;
      output.height = 1400;
      const ctx = output.getContext('2d');
      ctx.fillStyle = 'white';ctx.fillRect(0,0,1000,1400);
      ctx.fillStyle = '#333';ctx.font = '28px sans-serif';
      ctx.fillText('このページは配信元のリンク切れで未取得です。',50,100);
      return output;
    }
    const path = pdf.pages[pageNumber-1].path;
    const img = new Image();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        img.src = '';
        reject(new Error('画像の読み込みが30秒を超えました。再度選択してください。 ' + path));
      }, 30000);
      img.onload = () => { clearTimeout(timer); resolve(); };
      img.onerror = () => { clearTimeout(timer); reject(new Error('画像を読み込めません。GitHubの配置を確認してください。 ' + path)); };
      img.src = path;
    });
    const output = document.createElement('canvas');
    output.width = img.naturalWidth;
    output.height = img.naturalHeight;
    output.getContext('2d').drawImage(img,0,0);
    return output;
  }
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({scale});
  const output = document.createElement('canvas');
  output.width = Math.ceil(viewport.width);
  output.height = Math.ceil(viewport.height);
  await page.render({canvasContext:output.getContext('2d'), viewport}).promise;
  return output;
}

async function showPage(pageNumber) {
  base = await renderPage(activePdf, pageNumber, 1.25);
  currentPage = pageNumber;
  crop = null;
  canvas.width = base.width;
  canvas.height = base.height;
  canvas.hidden = false;
  $('page').textContent = currentPage + ' / ' + activePdf.numPages + ' ページ';
  paint();
}

function paint() {
  if (!base) return;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(base, 0, 0);
  if (!crop) return;
  const box = [crop.x*canvas.width, crop.y*canvas.height, crop.w*canvas.width, crop.h*canvas.height];
  ctx.fillStyle = '#15937730';
  ctx.strokeStyle = '#087359';
  ctx.lineWidth = 3;
  ctx.fillRect(...box);
  ctx.strokeRect(...box);
}

function point(event) {
  const rect = canvas.getBoundingClientRect();
  const clamp = value => Math.min(1, Math.max(0,value));
  return {x:clamp((event.clientX-rect.left)/rect.width),y:clamp((event.clientY-rect.top)/rect.height)};
}

canvas.onpointerdown = event => {
  if (!base || event.button !== 0) return;
  canvas.setPointerCapture(event.pointerId);
  start = point(event);
};
canvas.onpointermove = event => {
  if (!start) return;
  const end = point(event);
  crop = {x:Math.min(start.x,end.x), y:Math.min(start.y,end.y), w:Math.abs(start.x-end.x), h:Math.abs(start.y-end.y)};
  paint();
};
canvas.onpointerup = canvas.onpointercancel = () => {
  start = null;
  if (crop && (crop.w < .01 || crop.h < .01)) crop = null;
  paint();
};

function updateParts() {
  $('parts').textContent = parts.length ? parts.map(part => 'p.' + part.page).join(' → ') : '範囲未追加';
}

async function changeSource() {
  parts = [];
  updateParts();
  base = null;
  canvas.hidden = true;
  const source = data.sources.find(item => item.id === $('source').value);
  if (!source) return;
  const nextPdf = await openSource(source);
  if (activePdf) await activePdf.destroy();
  activePdf = nextPdf;
  await showPage(1);
}

let busy = false;
async function run(control, action) {
  if (busy) return;
  busy = true;
  document.querySelector('main').inert = true;
  control.disabled = true;
  status('読み込み中です…');
  try { await action(); if ($('status').textContent === '読み込み中です…') status('準備ができました。'); }
  catch (error) { status(error.message || '処理に失敗しました。'); $('status').scrollIntoView({block:'start'}); }
  finally { control.disabled = false; busy = false; document.querySelector('main').inert = false; updateButtons(); }
}

function updateSources() {
  options('source', data.sources.map(source => [source.id, source.year + '年度 ／ ' + source.name]));
}

$('upload').onsubmit = event => {
  event.preventDefault();
  const form = event.currentTarget;
  run(form.querySelector('button'), async () => {
    const values = new FormData(form);
    const file = values.get('pdf');
    const bytes = await file.arrayBuffer();
    const pdf = await openPdf(bytes);
    await pdf.destroy();
    const source = {id:crypto.randomUUID(),year:+values.get('year'),name:file.name,bytes};
    await save({...data,sources:[...data.sources,source]});
    updateSources();
    $('source').value = source.id;
    updateList();
    await changeSource();
    status('PDFを登録しました。');
  });
};

$('source').onchange = () => run($('source'), changeSource);
$('prev').onclick = () => run($('prev'), async () => {
  if (base && currentPage > 1) await showPage(currentPage-1);
});
$('next').onclick = () => run($('next'), async () => {
  if (base && currentPage < activePdf.numPages) await showPage(currentPage+1);
});
$('part').onclick = () => {
  if (busy || !base) return;
  parts.push({page:currentPage,crop:crop ? {...crop} : null});
  updateParts();
};
$('reset').onclick = () => {
  if (busy) return;
  parts = [];
  crop = null;
  paint();
  updateParts();
};

$('entry').onsubmit = event => {
  event.preventDefault();
  const form = event.currentTarget;
  run(form.querySelector('button'), async () => {
    if (!base || !parts.length) throw new Error('ページ上で範囲を指定し「この範囲を追加」を押してください。');
    const values = new FormData(form);
    const tags = parseTags(values.get('tags'));
    const number = values.get('number').trim();
    if (!tags.length || !number) throw new Error('問題番号と単元を入力してください。');
    const entry = {id:crypto.randomUUID(),source:$('source').value,number,tags,answer:values.get('answer').trim(),parts:[...parts]};
    await save({...data,entries:[...data.entries,entry]});
    form.reset();
    parts = [];
    crop = null;
    paint();
    updateParts();
    updateList();
    status('問題を登録しました。');
  });
};

async function print(answers) {
  const paper = $('paper');
  paper.replaceChildren();
  paper.classList.toggle('answers', answers);
  const heading = document.createElement('h1');
  heading.textContent = answers ? '都立入試 理科 正答' : '都立入試 理科 過去問';
  paper.append(heading);
  const pdfs = new Map();
  const answerYears = new Set();
  try {
    for (const entry of data.entries.filter(entry => selected.has(entry.id) && !entry.incomplete)) {
      const source = data.sources.find(source => source.id === entry.source);
      const title = source.year + '年度 ／ ' + entry.number;
      if (answers && source.answers) {
        if (answerYears.has(source.year)) continue;
        answerYears.add(source.year);
        const answerPdf = await openSource(source.answers);
        try {
          for (let pageNumber = 1; pageNumber <= answerPdf.numPages; pageNumber++) {
            const rendered = await renderPage(answerPdf,pageNumber,2);
            const article = document.createElement('article');
            const label = document.createElement('p');
            label.textContent = source.year + '年度 公式正答表（年度全体）';
            const img = new Image();
            img.src = rendered.toDataURL('image/png');
            await img.decode();
            article.append(label,img);
            paper.append(article);
          }
        } finally { await answerPdf.destroy(); }
        continue;
      }
      if (!answers && !pdfs.has(source.id)) pdfs.set(source.id, await openSource(source));
      for (const part of answers ? [null] : entry.parts) {
        const article = document.createElement('article');
        const label = document.createElement('p');
        label.textContent = title + (answers ? '　' + (entry.answer || '正答未登録') : '　原本 PDF p.' + part.page);
        article.append(label);
        if (part) {
          const rendered = await renderPage(pdfs.get(source.id), part.page, 2);
          const box = part.crop || {x:0,y:0,w:1,h:1};
          const imageCanvas = document.createElement('canvas');
          imageCanvas.width = Math.ceil(rendered.width*box.w);
          imageCanvas.height = Math.ceil(rendered.height*box.h);
          imageCanvas.getContext('2d').drawImage(rendered,rendered.width*box.x,rendered.height*box.y,rendered.width*box.w,rendered.height*box.h,0,0,imageCanvas.width,imageCanvas.height);
          const img = new Image();
          img.src = imageCanvas.toDataURL('image/png');
          await img.decode();
          article.append(img);
        }
        paper.append(article);
      }
    }
  } finally {
    await Promise.all([...pdfs.values()].map(pdf => pdf.destroy()));
  }
  document.body.classList.add('print-preview');
  $('printControls').hidden = false;
  window.scrollTo(0,0);
}

$('yearFilter').onchange = $('tagFilter').onchange = updateList;
$('questions').onclick = () => run($('questions'), () => print(false));
$('answers').onclick = () => run($('answers'), () => print(true));

const previewStyle = document.createElement('style');
previewStyle.textContent = `
@media screen {
  body.print-preview header, body.print-preview main { display:none !important; }
  body.print-preview #paper { display:block;max-width:800px;margin:20px auto;padding:20px;background:white; }
  #printControls { position:sticky;top:0;background:#dceae5;padding:12px;text-align:center;z-index:30; }
}
@media print { #printControls { display:none !important; } }
`;
document.head.append(previewStyle);
const printControls = document.createElement('div');
printControls.id = 'printControls';
printControls.hidden = true;
const printNow = document.createElement('button');
printNow.textContent = 'この内容を印刷 / PDF保存';
printNow.onclick = () => window.print();
const closePreview = document.createElement('button');
closePreview.textContent = '問題一覧に戻る';
closePreview.onclick = () => {
  document.body.classList.remove('print-preview');
  printControls.hidden = true;
};
printControls.append(printNow, closePreview);
document.body.prepend(printControls);

updateButtons();

await run($('upload').querySelector('button'), async () => {
  const request = indexedDB.open('tokyo-science-pastpapers',1);
  request.onupgradeneeded = () => request.result.createObjectStore('data');
  db = await requestResult(request);
  data = await requestResult(db.transaction('data').objectStore('data').get('catalog')) || data;
  const response = await fetch('./catalog.json');
  if (!response.ok) throw new Error('catalog.jsonを読み込めません。ZIPの全ファイルを配置してください。');
  bundled = await response.json();
  data.sources = [...bundled.sources, ...data.sources.filter(source => !source.builtin)];
  const stored = new Map(data.entries.map(entry => [entry.id,entry]));
  data.entries = [...bundled.entries.map(entry => stored.get(entry.id) || entry), ...data.entries.filter(entry => !entry.builtin)];
  $('summary').textContent = bundled.summary;
  $('downloadReport').textContent = bundled.report.join(' ／ ');
  updateSources();
  updateList();
  updateParts();
  if (data.sources.length) await changeSource();
});
