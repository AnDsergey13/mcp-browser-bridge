// mcp.ts — 15 MCP-инструментов (фаза 7). Каждый ответ: {ok, data|error_code, hint, policy_reminder}.
// Здесь же общее состояние моста: реестр вкладок, кэш снапшотов (для классификатора
// и reconcile), паузы (pause.global / pause.auto / resume + STATE_DIVERGED), gating-флоу.
import crypto from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Transport, BridgeError } from './transport.ts';
import { PolicyEngine, hostOf, type GatedCategory, type ResolvedDomain } from './policy.ts';
import { classifyUrl, classifyElement, parseSnapshotRefs, type ElementMeta } from './classifier.ts';
import { Pacing, PacingLimitError } from './pacing.ts';
import { capResponse } from './compress.ts';
import { MemoryStore } from './memory.ts';
import { DownloadRelay } from './downloads.ts';

export interface ToolPayload {
  ok: boolean;
  data?: unknown;
  error_code?: string;
  hint: string | null;
  policy_reminder: Record<string, unknown>;
}

interface TabInfo { url: string; title: string }
interface CachedSnapshot { text: string; dom_hash: string; refs: Map<string, ElementMeta>; url: string }
interface AutoPause { reason: string; checkpoint: { url: string | null; dom_hash: string | null } }

const PAGE_TOOLS = new Set(['page.snapshot', 'page.extract', 'page.find', 'page.screenshot']);
const ACT_TOOLS = new Set(['act.click', 'act.type', 'act.select', 'act.scroll', 'act.key']);

function shortHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export class BridgeCore {
  transport: Transport;
  policy: PolicyEngine;
  pacing: Pacing;
  memory: MemoryStore;
  downloads: DownloadRelay;
  consentTimeoutMs: number;
  log: (msg: string) => void;

  private tabs = new Map<number, TabInfo>();
  private snapshots = new Map<number, CachedSnapshot>();
  private globalPaused = false;
  private autoPaused = new Map<number, AutoPause>();
  private diverged = new Map<number, { url: string; dom_hash: string }>();
  private consentSeq = 0;

  constructor(deps: {
    transport: Transport;
    policy: PolicyEngine;
    pacing: Pacing;
    memory: MemoryStore;
    downloads: DownloadRelay;
    consentTimeoutMs?: number;
    log?: (msg: string) => void;
  }) {
    this.transport = deps.transport;
    this.policy = deps.policy;
    this.pacing = deps.pacing;
    this.memory = deps.memory;
    this.downloads = deps.downloads;
    this.consentTimeoutMs = deps.consentTimeoutMs ?? 120_000;
    this.log = deps.log ?? (() => {});
  }

  /** События паузы от расширения (вызывается из index). */
  handlePauseEvent(event: string, data: Record<string, unknown>): void {
    if (event === 'pause.global') {
      this.globalPaused = data['paused'] === true;
      this.log(`core: pause.global=${this.globalPaused}`);
      return;
    }
    const tabId = Number(data['tabId']);
    if (!Number.isFinite(tabId)) return;
    if (event === 'pause.auto') {
      const known = this.tabs.get(tabId);
      const snap = this.snapshots.get(tabId);
      this.autoPaused.set(tabId, {
        reason: String(data['reason'] ?? 'auto'),
        checkpoint: { url: known?.url ?? snap?.url ?? null, dom_hash: snap?.dom_hash ?? null },
      });
      this.log(`core: pause.auto tab=${tabId} reason=${data['reason'] ?? '?'}`);
      // Уточняем чекпоинт свежим getStateHash (best effort).
      this.transport.request('getStateHash', { tabId }).then((res) => {
        const r = res as { url?: string; dom_hash?: string };
        const p = this.autoPaused.get(tabId);
        if (p) p.checkpoint = { url: r.url ?? p.checkpoint.url, dom_hash: r.dom_hash ?? p.checkpoint.dom_hash };
      }).catch(() => {});
      return;
    }
    if (event === 'resume') {
      void this.handleResume(tabId);
    }
  }

  private async handleResume(tabId: number): Promise<void> {
    const pause = this.autoPaused.get(tabId);
    this.autoPaused.delete(tabId);
    if (!pause) return;
    try {
      const res = await this.transport.request('getStateHash', { tabId }) as { url?: string; dom_hash?: string };
      const cp = pause.checkpoint;
      const divergedNow = (cp.url && res.url !== cp.url) || (cp.dom_hash && res.dom_hash !== cp.dom_hash);
      if (divergedNow) {
        this.log(`core: STATE_DIVERGED tab=${tabId}`);
        this.diverged.set(tabId, { url: res.url ?? '', dom_hash: res.dom_hash ?? '' });
      }
    } catch {
      // Браузер офлайн — инструменты и так упадут с BROWSER_OFFLINE.
    }
  }

  private fail(error_code: string, hint: string, reminder: Record<string, unknown>, data?: unknown): ToolPayload {
    const p: ToolPayload = { ok: false, error_code, hint, policy_reminder: reminder };
    if (data !== undefined) p.data = data;
    return p;
  }

  /** Главный конвейер исполнения инструмента. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolPayload> {
    const tabId = typeof args['tabId'] === 'number' ? (args['tabId'] as number) : null;
    let urlForReminder: string | null = tabId !== null ? (this.tabs.get(tabId)?.url ?? null) : (typeof args['url'] === 'string' ? args['url'] : null);
    let resolved: ResolvedDomain | null = urlForReminder ? this.policy.resolveDomain(urlForReminder) : null;

    const finish = (payload: ToolPayload): ToolPayload => {
      this.memory.journal({ tool: name, args, result: payload, tabId, url: urlForReminder });
      return payload;
    };
    const reminder = (): Record<string, unknown> => this.memory.buildPolicyReminder(this.policy, resolved);

    try {
      // 1. Состояние сессии (policy.status работает всегда — он и докладывает состояние).
      if (name !== 'policy.status') {
        const st = this.transport.getState();
        if (st === 'offline') return finish(this.fail('BROWSER_OFFLINE', 'Расширение не подключено. Попроси пользователя открыть браузер с расширением моста.', reminder()));
        if (st === 'pending_approval') return finish(this.fail('SESSION_NOT_APPROVED', 'Пользователь ещё не подтвердил сессию агента в расширении.', reminder()));
        if (st === 'denied') return finish(this.fail('SESSION_DENIED', 'Пользователь отклонил сессию агента. Работа невозможна.', reminder()));
        // 2. Паузы.
        if (this.globalPaused) return finish(this.fail('PAUSED', 'Глобальная пауза (красная кнопка в popup). Жди снятия паузы пользователем.', reminder()));
        if (tabId !== null && this.autoPaused.has(tabId)) {
          const p = this.autoPaused.get(tabId)!;
          return finish(this.fail('AUTO_PAUSED_HUMAN_NEEDED', `Вкладка на авто-паузе (${p.reason}). Нужен человек; не повторяй действие до resume.`, reminder()));
        }
        // 3. N5: после resume с расхождением — один раз STATE_DIVERGED + свежие {url, dom_hash}.
        if (tabId !== null && this.diverged.has(tabId)) {
          const d = this.diverged.get(tabId)!;
          this.diverged.delete(tabId);
          return finish(this.fail('STATE_DIVERGED', 'Состояние вкладки изменилось за время паузы. Сделай свежий page.snapshot и перепланируй действия.', reminder(), { url: d.url, dom_hash: d.dom_hash }));
        }
      }

      // 4. Специальные инструменты без page-конвейера.
      if (name === 'policy.status') return finish(this.toolPolicyStatus());
      if (name === 'policy.request_preset') return finish(await this.toolRequestPreset(String(args['name'] ?? ''), reminder));

      // 5. Определяем целевой URL и capability.
      const capability = PAGE_TOOLS.has(name) ? 'read' : ACT_TOOLS.has(name) ? 'interact' : name === 'file.download' ? 'download' : null;
      let targetUrl: string | null = null;
      if (name === 'tab.open') {
        targetUrl = String(args['url'] ?? '');
      } else if (tabId !== null && name !== 'tab.list') {
        const known = this.tabs.get(tabId);
        if (!known) {
          return finish(this.fail('NO_TAB', `Вкладка ${tabId} неизвестна серверу. Сначала tab.list.`, reminder()));
        }
        // tab.close тоже идёт через policy (interact): нельзя закрыть чужую вкладку.
        // file.download: проверяем домен ФАЙЛА, а не вкладки — capability download
        // должна быть выдана домену, с которого реально скачиваем.
        targetUrl = name === 'file.download' ? String(args['url'] ?? '') : known.url;
      }

      // 6. Policy-проверка: домен + capability + gated-категория.
      if (targetUrl) {
        const category = this.classify(name, args, tabId, targetUrl);
        const check = this.policy.check(targetUrl, capability as 'read' | 'interact' | 'download' | null, category);
        resolved = check.resolved;
        if (check.decision === 'deny') return finish(this.fail(check.error_code, check.hint, reminder()));
        if (check.decision === 'consent') {
          const decision = await this.askConsent(check.category, this.describeAction(name, args), check.resolved.key, tabId ?? 0);
          if (decision === 'deny') {
            this.policy.audit({ kind: 'deny', domain: check.resolved.key, category: check.category, decision: 'consent_deny' });
            return finish(this.fail('ACTION_DENIED', `Пользователь не подтвердил действие категории "${check.category}" (deny/timeout). Не повторяй без изменения замысла.`, reminder()));
          }
          if (decision === 'allow_10min') this.policy.cacheAllow10min(check.resolved.key, check.category);
          else this.policy.audit({ kind: 'grant', domain: check.resolved.key, category: check.category, decision: 'consent_allow' });
        }
      }

      // 7. Pacing (N6) для act.*.
      if (ACT_TOOLS.has(name)) await this.pacing.beforeAction();

      // 8. Исполнение.
      const data = await this.execute(name, args, tabId);
      urlForReminder = (data && typeof data === 'object' && typeof (data as Record<string, unknown>)['url'] === 'string')
        ? (data as Record<string, unknown>)['url'] as string
        : urlForReminder;
      resolved = urlForReminder ? this.policy.resolveDomain(urlForReminder) : resolved;

      // 9. N15: контент страниц — untrusted.
      if (PAGE_TOOLS.has(name) && data && typeof data === 'object') {
        (data as Record<string, unknown>)['untrusted_page_content'] = true;
      }

      // 10. N7: страховочная резка.
      const capped = capResponse(data);
      return finish({ ok: true, data: capped.data, hint: capped.hint, policy_reminder: reminder() });
    } catch (err) {
      if (err instanceof PacingLimitError) {
        return finish(this.fail('PACING_LIMIT', `Human-pacing: ${err.message}. Подожди и замедли темп действий.`, reminder()));
      }
      const be = err as Partial<BridgeError>;
      const code = be.code ?? 'INTERNAL';
      const hints: Record<string, string> = {
        BROWSER_OFFLINE: 'Соединение с браузером потеряно. Попроси пользователя проверить браузер/расширение.',
        TIMEOUT: 'Расширение не ответило вовремя. Повтори или сделай свежий page.snapshot.',
        STALE_REF: 'ref инвалидирован (страница изменилась). Сделай свежий page.snapshot и используй новые ref.',
        NO_TAB: 'Вкладка не найдена. Сделай tab.list.',
        FETCH_FAILED: 'Скачивание не удалось. Проверь URL и попробуй ещё раз.',
        CONTENT_SCRIPT_ABSENT: 'Домен вне match_patterns политики — content script не загружен.',
        NAV_TIMEOUT: 'Навигация не завершилась вовремя.',
      };
      return finish(this.fail(code, hints[code] ?? (be.message ?? 'Внутренняя ошибка сервера'), reminder()));
    }
  }

  private classify(name: string, args: Record<string, unknown>, tabId: number | null, targetUrl: string): GatedCategory | null {
    if (name === 'tab.open') return classifyUrl(targetUrl);
    if ((name === 'act.click' || name === 'act.type' || name === 'act.select') && tabId !== null) {
      // click-by-text: элемента в снапшоте нет — классифицируем по самому тексту запроса.
      if (name === 'act.click' && !args['ref'] && args['text']) {
        return classifyElement({ ref: '', role: 'button', text: String(args['text']), href: null, attrs: {} });
      }
      const ref = String(args['ref'] ?? '');
      const snap = this.snapshots.get(tabId);
      return classifyElement(snap?.refs.get(ref));
    }
    return null;
  }

  private describeAction(name: string, args: Record<string, unknown>): string {
    if (name === 'tab.open') return `Открыть ${String(args['url'] ?? '')}`;
    return `${name} ref=${String(args['ref'] ?? '-')}`;
  }

  private async askConsent(category: GatedCategory | 'custom', description: string, domain: string, tabId: number): Promise<'allow' | 'deny' | 'allow_10min'> {
    const requestId = `c_${++this.consentSeq}`;
    try {
      const res = await this.transport.request('consent.ask', {
        requestId, category, description, domain, tabId, timeout_ms: this.consentTimeoutMs,
      }, this.consentTimeoutMs + 1000) as { decision?: string };
      if (res && (res.decision === 'allow' || res.decision === 'allow_10min' || res.decision === 'deny')) return res.decision;
      return 'deny';
    } catch {
      return 'deny'; // таймаут/офлайн → запрет
    }
  }

  private toolPolicyStatus(): ToolPayload {
    const view = this.policy.buildPolicyUpdate();
    const data = {
      preset: view.preset,
      preset_description: this.policy.presetDescription(),
      presets_available: this.policy.presetNames(),
      domains: view.domains,
      gated_defaults: view.gated_defaults,
      policy_version: view.version,
      session_state: this.transport.getState(),
      paused: { global: this.globalPaused, auto_tabs: [...this.autoPaused.keys()] },
      pacing: this.policy.pacing(),
    };
    return { ok: true, data, hint: null, policy_reminder: this.memory.buildPolicyReminder(this.policy, null) };
  }

  private async toolRequestPreset(name: string, reminder: () => Record<string, unknown>): Promise<ToolPayload> {
    if (!name) return this.fail('INTERNAL', 'Укажи имя пресета (name).', reminder());
    if (!this.policy.hasPreset(name)) {
      return this.fail('INTERNAL', `Неизвестный пресет "${name}". Доступные: ${this.policy.presetNames().join(', ')}.`, reminder());
    }
    if (this.policy.activePreset() === name) {
      return { ok: true, data: { preset: name, switched: false }, hint: null, policy_reminder: reminder() };
    }
    // Агент не может сам себе расширить права: переключение — через баннер подтверждения.
    const decision = await this.askConsent('custom', `Агент просит переключить пресет политики: "${this.policy.activePreset()}" → "${name}"`, '', 0);
    if (decision === 'deny') {
      this.policy.audit({ kind: 'deny', decision: 'preset_switch_denied', preset: name });
      return this.fail('ACTION_DENIED', `Пользователь не подтвердил переключение на пресет "${name}". Продолжай в рамках текущего пресета.`, reminder());
    }
    this.policy.setActivePreset(name); // шлёт policy.update через onChange
    return { ok: true, data: { preset: name, switched: true }, hint: null, policy_reminder: this.memory.buildPolicyReminder(this.policy, null) };
  }

  private async execute(name: string, args: Record<string, unknown>, tabId: number | null): Promise<unknown> {
    switch (name) {
      case 'tab.list': {
        const res = await this.transport.request('tab.list', {}) as { tabs?: { tabId: number; url: string; title: string; active?: boolean }[] };
        const all = res.tabs ?? [];
        // N15/default-deny: агенту видны только вкладки с грантованных доменов;
        // чужие вкладки не раскрываем (ни URL, ни title) — только их количество.
        const visible: typeof all = [];
        let hidden = 0;
        for (const t of all) {
          if (this.policy.check(t.url, 'read', null).decision === 'allow') {
            this.tabs.set(t.tabId, { url: t.url, title: t.title });
            visible.push(t);
          } else {
            hidden++;
          }
        }
        return { tabs: visible, hidden_tabs: hidden };
      }
      case 'tab.open': {
        // С tabId — навигация существующей вкладки (без новой); без — tabs.create.
        if (tabId !== null) {
          const res = await this.transport.request('navigate', { tabId, url: args['url'] }) as { url?: string; title?: string };
          if (res.url) this.tabs.set(tabId, { url: res.url, title: res.title ?? '' });
          return { tabId, ...res };
        }
        const res = await this.transport.request('tab.open', { url: args['url'], active: args['active'] }) as { tabId: number; url: string; title: string };
        this.tabs.set(res.tabId, { url: res.url, title: res.title });
        return res;
      }
      case 'tab.close': {
        const res = await this.transport.request('tab.close', { tabId });
        if (tabId !== null) { this.tabs.delete(tabId); this.snapshots.delete(tabId); }
        return res;
      }
      case 'page.snapshot': {
        const res = await this.transport.request('snapshot', { tabId, scope: args['scope'], selector: args['selector'] }) as Record<string, unknown> & { snapshot?: string; url?: string; title?: string };
        if (tabId !== null && typeof res.snapshot === 'string') {
          this.snapshots.set(tabId, { text: res.snapshot, dom_hash: shortHash(res.snapshot), refs: parseSnapshotRefs(res.snapshot), url: res.url ?? '' });
        }
        if (tabId !== null && res.url) this.tabs.set(tabId, { url: res.url, title: res.title ?? '' });
        return res;
      }
      case 'page.extract':
        return this.pageCommand('extractMarkdown', tabId, { selector: args['selector'] });
      case 'page.find':
        return this.pageCommand('findText', tabId, { query: args['query'], role: args['role'] });
      case 'page.screenshot':
        return this.pageCommand('screenshot', tabId, {});
      case 'act.click': {
        if (!args['ref'] && !args['text']) throw new Error('act.click: нужен ref или text');
        return this.pageCommand('click', tabId, { ref: args['ref'], text: args['text'] });
      }
      case 'act.type':
        return this.pageCommand('type', tabId, { ref: args['ref'], text: args['text'], clear: args['clear'] });
      case 'act.select':
        return this.pageCommand('select', tabId, { ref: args['ref'], value: args['value'] });
      case 'act.scroll':
        if (args['ref']) return this.pageCommand('scrollIntoView', tabId, { ref: args['ref'] });
        return this.pageCommand('scroll', tabId, { dy: args['dy'] ?? 600 });
      case 'act.key':
        return this.pageCommand('pressKey', tabId, { key: args['key'] });
      case 'file.download':
        return this.executeDownload(tabId, String(args['url'] ?? ''), args['name'] ? String(args['name']) : undefined);
      default:
        throw new BridgeError('INTERNAL', `неизвестный инструмент: ${name}`);
    }
  }

  private async pageCommand(method: string, tabId: number | null, params: Record<string, unknown>): Promise<unknown> {
    const res = await this.transport.request(method, { tabId, ...params }) as Record<string, unknown> & { url?: string; title?: string };
    if (tabId !== null && typeof res?.url === 'string') {
      this.tabs.set(tabId, { url: res.url, title: typeof res.title === 'string' ? res.title : '' });
    }
    return res;
  }

  private async executeDownload(tabId: number | null, url: string, name?: string): Promise<unknown> {
    const transferPromise = this.downloads.expectTransfer(url);
    transferPromise.catch(() => {}); // страховка от unhandled rejection
    const resPromise = this.transport.request('fetchFile', { tabId, url, name }, 120_000);
    const [completed, res] = await Promise.all([transferPromise, resPromise]);
    return { ...(res as Record<string, unknown>), file: completed.name, size: completed.size, sha256: completed.sha256 };
  }
}

// ---- регистрация в MCP SDK ----

export function buildMcpServer(core: BridgeCore): McpServer {
  const server = new McpServer({ name: 'bridge-server', version: '0.1.0' });
  const tabId = z.number().describe('ID вкладки из tab.list');
  const ref = z.string().describe('ref-метка элемента из page.snapshot (e1, e2, …)');

  const defs: [string, string, Record<string, z.ZodTypeAny>][] = [
    ['tab.list', 'Список вкладок браузера', {}],
    ['tab.open', 'Открыть URL (без tabId — новая вкладка; с tabId — навигация существующей)', { url: z.string(), tabId: tabId.optional(), active: z.boolean().optional() }],
    ['tab.close', 'Закрыть вкладку', { tabId }],
    ['page.snapshot', 'Семантический снапшот страницы (интерактивные элементы с ref-метками)', { tabId, scope: z.enum(['viewport', 'main', 'full']).optional(), selector: z.string().optional() }],
    ['page.extract', 'Чистый markdown содержимого страницы', { tabId, selector: z.string().optional() }],
    ['page.find', 'Поиск по тексту/роли без полного снапшота (≤20 совпадений)', { tabId, query: z.string(), role: z.string().optional() }],
    ['page.screenshot', 'Скриншот вкладки (JPEG base64, ≤1280px)', { tabId }],
    ['act.click', 'Клик по элементу (ref из снапшота ИЛИ text — атомарный поиск+клик по тексту, устойчив к STALE_REF)', { tabId, ref: ref.optional(), text: z.string().optional() }],
    ['act.type', 'Ввод текста в элемент', { tabId, ref, text: z.string(), clear: z.boolean().optional() }],
    ['act.select', 'Выбор значения в <select>', { tabId, ref, value: z.string() }],
    ['act.scroll', 'Скролл на dy пикселей или scrollIntoView к ref', { tabId, dy: z.number().optional(), ref: ref.optional() }],
    ['act.key', 'Нажатие клавиши (Enter, Tab, Escape, …)', { tabId, key: z.string() }],
    ['file.download', 'Скачать файл со страницы через браузерную сессию (WS-релей в downloads/)', { tabId, url: z.string(), name: z.string().optional() }],
    ['policy.status', 'Активный пресет, гранты, gated-правила, состояние пауз', {}],
    ['policy.request_preset', 'Запросить переключение пресета политики (требует подтверждения пользователя)', { name: z.string() }],
  ];

  for (const [name, description, shape] of defs) {
    server.registerTool(name, { description, inputSchema: shape }, async (args) => {
      const payload = await core.callTool(name, args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
    });
  }
  return server;
}
