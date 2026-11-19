#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, deflateSync } from 'node:zlib';

const SAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const TARGET_BYTES = 3_000_000;

// Детерминированный ГПСЧ: повторный запуск даёт побайтово те же файлы.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(...buffers) {
  let crc = 0xffffffff;
  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- PNG ----------

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeBuf, data));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function buildPng(width, height) {
  const random = mulberry32(0x504e47);
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // фильтр строки: None
    for (let x = 0; x < width; x++) {
      const i = y * stride + 1 + x * 3;
      const noise = () => random() * 160 - 80;
      raw[i] = clamp((x / width) * 255 + noise());
      raw[i + 1] = clamp((y / height) * 255 + noise());
      raw[i + 2] = clamp(255 - ((x + y) / (width + height)) * 255 + noise());
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // бит на канал
  header[9] = 2; // RGB
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp(value) {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

// ---------- PDF ----------

const WORDS = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ' +
  'ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco ' +
  'laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate ' +
  'velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident'
).split(' ');

function buildPdf(targetBytes) {
  const random = mulberry32(0x504446);
  const linesPerPage = 64;
  const pageStreams = [];
  let contentBytes = 0;
  let lineNo = 0;

  while (contentBytes < targetBytes) {
    const lines = [
      'BT',
      '/F1 9 Tf',
      '11.5 TL',
      '40 800 Td',
      `(Download bench sample - page ${pageStreams.length + 1}) Tj T* T*`,
    ];
    for (let i = 0; i < linesPerPage; i++) {
      let text = `${String(++lineNo).padStart(6, '0')}.`;
      while (text.length < 110) text += ' ' + WORDS[Math.floor(random() * WORDS.length)];
      lines.push(`(${text}) Tj T*`);
    }
    lines.push('ET');
    const stream = lines.join('\n');
    pageStreams.push(stream);
    contentBytes += stream.length;
  }

  // 1 — каталог, 2 — дерево страниц, 3 — шрифт, дальше пары «страница + поток».
  const objects = [];
  const pageIds = pageStreams.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pageStreams.forEach((stream, i) => {
    const pageId = pageIds[i];
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0].length;
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = offset;
    const chunk = Buffer.from(`${id} 0 obj\n${objects[id]}\nendobj\n`, 'latin1');
    parts.push(chunk);
    offset += chunk.length;
  }

  const xref = [`xref\n0 ${objects.length}\n`, '0000000000 65535 f \n'];
  for (let id = 1; id < objects.length; id++) {
    xref.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  xref.push(`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
  parts.push(Buffer.from(xref.join(''), 'latin1'));

  return Buffer.concat(parts);
}

// ---------- XLSX ----------

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function buildSheetXml(rowCount) {
  const random = mulberry32(0x584c53);
  const regions = ['Москва', 'Санкт-Петербург', 'Казань', 'Новосибирск', 'Екатеринбург', 'Алматы'];
  const products = ['Ноутбук', 'Монитор', 'Клавиатура', 'Мышь', 'Наушники', 'Принтер', 'Роутер'];
  const header = ['ID', 'Дата', 'Регион', 'Товар', 'Количество', 'Цена', 'Сумма', 'Код'];

  const cell = (col, row, value) =>
    typeof value === 'number'
      ? `<c r="${columnName(col)}${row}"><v>${value}</v></c>`
      : `<c r="${columnName(col)}${row}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
  const rowXml = (row, values) => `<row r="${row}">${values.map((v, col) => cell(col, row, v)).join('')}</row>`;

  const rows = [rowXml(1, header)];
  const start = Date.UTC(2025, 0, 1);
  for (let row = 2; row <= rowCount + 1; row++) {
    const quantity = 1 + Math.floor(random() * 50);
    const price = Math.round((500 + random() * 150_000) * 100) / 100;
    const date = new Date(start + Math.floor(random() * 365) * 86_400_000).toISOString().slice(0, 10);
    const code = Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0').toUpperCase();
    rows.push(
      rowXml(row, [
        row - 1,
        date,
        regions[Math.floor(random() * regions.length)],
        products[Math.floor(random() * products.length)],
        quantity,
        price,
        Math.round(quantity * price * 100) / 100,
        code,
      ]),
    );
  }

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="A1:${columnName(header.length - 1)}${rowCount + 1}"/>` +
    `<sheetData>${rows.join('')}</sheetData></worksheet>`
  );
}

function buildXlsx(rowCount) {
  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Продажи" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>',
    'xl/worksheets/sheet1.xml': buildSheetXml(rowCount),
  };
  return buildZip(files);
}

// Минимальный ZIP (метод deflate) без сторонних библиотек.
function buildZip(files) {
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // имена в UTF-8
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDir, end]);
}

// ---------- main ----------

const samples = [
  ['picture.png', () => buildPng(1200, 1000)],
  ['document.pdf', () => buildPdf(TARGET_BYTES)],
  ['table.xlsx', () => buildXlsx(60_000)],
];

mkdirSync(SAMPLES_DIR, { recursive: true });
for (const [name, build] of samples) {
  const data = build();
  writeFileSync(join(SAMPLES_DIR, name), data);
  console.log(`${name.padEnd(14)} ${(data.length / 1_000_000).toFixed(2)} MB`);
}
console.log(`\nФайлы сохранены в ${SAMPLES_DIR}`);
