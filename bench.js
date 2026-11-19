#!/usr/bin/env node

const REQUESTS = 10;
const BYTES_IN_MB = 1_000_000;

const REQUEST_HEADERS = {
  // Без сжатия считаем ровно те байты, что пришли по сети.
  'accept-encoding': 'identity',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
};

function printUsage() {
  console.error('Использование: node bench.js <url>');
  console.error('Пример:        node bench.js http://127.0.0.1:8080/picture.png');
}

function parseUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function describeError(error) {
  const cause = error.cause;
  return cause?.message || cause?.code || error.message;
}

async function download(url) {
  const started = performance.now();
  const response = await fetch(url, { headers: REQUEST_HEADERS });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`сервер ответил HTTP ${response.status} ${response.statusText}`.trim());
  }

  let bytes = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
    }
  }

  return { status: response.status, bytes, ms: performance.now() - started };
}

const formatMb = (bytes) => (bytes / BYTES_IN_MB).toFixed(2);
const formatMs = (ms) => ms.toFixed(1);

async function main() {
  const url = parseUrl(process.argv[2] ?? '');
  if (!url) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  console.log(`URL: ${url.href}`);
  console.log(`Запросов: ${REQUESTS}, строго по очереди\n`);

  const results = [];
  for (let i = 1; i <= REQUESTS; i++) {
    let result;
    try {
      result = await download(url);
    } catch (error) {
      console.error(`Запрос #${i} не выполнен: ${describeError(error)}`);
      process.exitCode = 1;
      return;
    }

    results.push(result);
    console.log(
      `#${String(i).padStart(2)}  HTTP ${result.status}  ` +
        `${formatMb(result.bytes).padStart(8)} MB  ${formatMs(result.ms).padStart(9)} мс`,
    );
  }

  const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);
  const averageMs = totalMs / results.length;
  const speedMbPerSec = totalBytes / BYTES_IN_MB / (totalMs / 1000);

  console.log('');
  console.log(`Среднее время запроса: ${formatMs(averageMs)} мс`);
  console.log(`Скачано всего:         ${formatMb(totalBytes)} MB`);
  console.log(`Скорость скачивания:   ${speedMbPerSec.toFixed(2)} MB/s`);
}

await main();
