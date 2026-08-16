// live-check.mjs — живая проверка моста: поднимает сервер in-process,
// ждёт подтверждения сессии расширением и прогоняет реальные инструменты
// (tab.list, page.snapshot на localhost:8080, если открыт).
// После проверки продолжает работать как обычный сервер.
// Запуск: node --import tsx scripts/live-check.mjs
import { startBridge } from '../src/index.ts';

const log = (msg) => console.error(`[live-check] ${msg}`);

const handle = await startBridge({ mcp: false });
log('сервер поднят, жду active (подтверди сессию в popup расширения)…');

// Фаза 9: состояния per-client (мультиклиентность) — ждём ПЕРВЫЙ active клиент.
const anyActive = () =>
  handle.transport.listClients().some((c) => c.state === 'active');

await new Promise((resolve) => {
  if (anyActive()) return resolve();
  const prev = handle.transport.onStateChange;
  handle.transport.onStateChange = (clientId, s) => {
    if (prev) prev(clientId, s);
    if (s === 'active') resolve();
  };
  setTimeout(resolve, 5 * 60 * 1000); // страховка — не висеть вечно
});

log(`клиенты: ${JSON.stringify(handle.transport.listClients())}`);
if (!anyActive()) {
  log('не дождался подтверждения за 5 минут');
  process.exit(1);
}

const show = (name, payload) => {
  const text = JSON.stringify(payload, null, 2);
  log(`--- ${name} ---\n${text.length > 3000 ? text.slice(0, 3000) + '\n…(обрезано)' : text}`);
};

const tabs = await handle.core.callTool('tab.list', {});
show('tab.list', tabs);

const tab8080 = tabs.ok && tabs.data.tabs.find((t) => (t.url || '').includes('localhost:8080'));
if (tab8080) {
  const snap = await handle.core.callTool('page.snapshot', { tabId: tab8080.tabId });
  show(`page.snapshot tabId=${tab8080.tabId}`, snap);
} else {
  log('вкладки localhost:8080 не нашёл — snapshot не прогонял');
}

log('проверка завершена, сервер продолжает работать');
