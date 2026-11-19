#!/usr/bin/env node

const REQUESTS = 10;
const BYTES_IN_MB = 1_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const REQUEST_HEADERS = {
  // Без сжатия считаем ровно те байты, что пришли по сети.
  'accept-encoding': 'identity',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
};

function printUsage() {
  console.error('Использование: node bench.js <url> [--timeout <секунды>]');
  console.error('Пример:        node bench.js http://127.0.0.1:8080/picture.png');
  console.error('Таймаут по умолчанию: 30 секунд на один запрос, вместе с чтением тела.');
}

function parseUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  let rawUrl;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      const raw = arg === '--timeout' ? argv[++i] : arg.slice('--timeout='.length);
      const seconds = Number(raw);
      if (!raw || !Number.isFinite(seconds) || seconds <= 0) {
        return { error: 'Таймаут задаётся в секундах и должен быть больше нуля.' };
      }
      timeoutMs = seconds * 1000;
      continue;
    }
    if (arg.startsWith('--')) return { error: `Неизвестный параметр ${arg}.` };
    if (rawUrl) return { error: 'Укажите один адрес.' };
    rawUrl = arg;
  }

  const url = parseUrl(rawUrl ?? '');
  if (!url) return { error: rawUrl ? 'Нужен адрес http:// или https://.' : null };
  return { url, timeoutMs };
}

function describeError(error) {
  if (isTimeout(error)) return null;
  const cause = error.cause;
  return cause?.message || cause?.code || error.message;
}

function isTimeout(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  return error.cause !== error && isTimeout(error.cause);
}

async function download(url, timeoutMs) {
  const started = performance.now();
  let response;
  try {
    response = await fetch(url, {
      headers: REQUEST_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isTimeout(error)) throw new Error(`таймаут ${timeoutMs} мс`);
    throw error;
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`сервер ответил HTTP ${response.status} ${response.statusText}`.trim());
  }

  // fetch() возвращает управление, когда пришли заголовки — это первые байты ответа.
  const firstByteMs = performance.now() - started;
  let bytes = 0;
  try {
    if (response.body) {
      for await (const chunk of response.body) bytes += chunk.byteLength;
    }
  } catch (error) {
    if (isTimeout(error)) throw new Error(`таймаут ${timeoutMs} мс`);
    throw error;
  }

  const ms = performance.now() - started;
  return { status: response.status, bytes, firstByteMs, bodyMs: ms - firstByteMs, ms };
}

const formatMb = (bytes) => (bytes / BYTES_IN_MB).toFixed(2);
const formatMs = (ms) => ms.toFixed(1);

const COLUMNS = [
  { header: 'запрос', width: 7, align: 'left' },
  { header: 'HTTP', width: 5, align: 'right' },
  { header: 'объём, MB', width: 9, align: 'right' },
  { header: 'первый байт, мс', width: 16, align: 'right' },
  { header: 'тело, мс', width: 8, align: 'right' },
  { header: 'всего, мс', width: 9, align: 'right' },
];

function pad(text, width, align) {
  const value = String(text);
  return align === 'left' ? value.padEnd(width) : value.padStart(width);
}

function formatHeader() {
  return COLUMNS.map((column) => pad(column.header, column.width, column.align)).join('  ');
}

function formatResult(label, result) {
  const values = [
    label,
    result.status,
    formatMb(result.bytes),
    formatMs(result.firstByteMs),
    formatMs(result.bodyMs),
    formatMs(result.ms),
  ];
  return values.map((value, index) => pad(value, COLUMNS[index].width, COLUMNS[index].align)).join('  ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    if (args.error) console.error(args.error);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const { url, timeoutMs } = args;
  console.log(`URL: ${url.href}`);
  console.log(`Запросов: ${REQUESTS}, строго по очереди`);
  console.log('Прогрев: 1 запрос, в среднее, объём и скорость не входит');
  console.log(`Таймаут: ${timeoutMs} мс на запрос\n`);

  let warmup;
  try {
    warmup = await download(url, timeoutMs);
  } catch (error) {
    console.error(`Прогрев не выполнен: ${describeError(error)}`);
    process.exitCode = 1;
    return;
  }
  console.log(formatHeader());
  console.log(formatResult('прогрев', warmup));

  const results = [];
  for (let i = 1; i <= REQUESTS; i++) {
    let result;
    try {
      result = await download(url, timeoutMs);
    } catch (error) {
      console.error(`Запрос #${i} не выполнен: ${describeError(error)}`);
      process.exitCode = 1;
      return;
    }

    results.push(result);
    console.log(formatResult(`#${i}`, result));
  }

  const totalBytes = results.reduce((sum, result) => sum + result.bytes, 0);
  const totalMs = results.reduce((sum, result) => sum + result.ms, 0);
  const totalFirstByteMs = results.reduce((sum, result) => sum + result.firstByteMs, 0);
  const totalBodyMs = results.reduce((sum, result) => sum + result.bodyMs, 0);
  const speedMbPerSec = totalBytes / BYTES_IN_MB / (totalMs / 1000);

  console.log('');
  console.log(`Среднее до первого байта: ${formatMs(totalFirstByteMs / results.length)} мс`);
  console.log(`Среднее скачивание тела:  ${formatMs(totalBodyMs / results.length)} мс`);
  console.log(`Среднее время запроса:    ${formatMs(totalMs / results.length)} мс`);
  console.log(`Скачано всего:            ${formatMb(totalBytes)} MB`);
  console.log(`Скорость скачивания:      ${speedMbPerSec.toFixed(2)} MB/s`);
}

await main();
