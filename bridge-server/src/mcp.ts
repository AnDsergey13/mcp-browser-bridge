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
// П0-3: scopeKey = scope|selector — без него снапшот scope:"full" после
// scope:"viewport" при совпадающем dom_hash дал бы ложный unchanged.
interface CachedSnapshot { text: string; dom_hash: string; refs: Map<string, ElementMeta>; url: string; scopeKey: string }
interface AutoPause { reason: string; checkpoint: { url: string | null; dom_hash: string | null } }

const PAGE_TOOLS = new Set(['page.snapshot', 'page.extract', 'page.find', 'page.screenshot', 'net.list', 'page.wait_for']);
// page.scan живёт в ACT_TOOLS: скроллит страницу → capability interact + pacing (П2-3).
const ACT_TOOLS = new Set(['act.click', 'act.type', 'act.select', 'act.scroll', 'act.key', 'act.batch', 'page.scan']);

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
  // П0-1: состояние версионирования policy_reminder.
  private reminderCounter = 0;
  private lastReminderHash: string | null = null;

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

  /**
   * П0-1: полный policy_reminder отдаём (а) при первом вызове сессии,
   * (б) при смене хэша содержимого (hot-reload policy.yaml, правка плейбука),
   * (в) раз в 10 вызовов, (г) на ЛЮБОЙ ошибке (forceFull — там reminder несёт
   * смысл для модели: гейтинг, паузы, расхождение состояния). Иначе — короткая
   * форма {preset, domain, reminder_version}; поле policy_reminder сохраняется
   * всегда (конверт ответа не меняется).
   */
  private versionedReminder(full: Record<string, unknown>, forceFull: boolean): Record<string, unknown> {
    const hash = shortHash(JSON.stringify(full));
    this.reminderCounter++;
    const due = forceFull || this.lastReminderHash === null ||
      this.lastReminderHash !== hash || this.reminderCounter >= 10;
    if (due) {
      this.lastReminderHash = hash;
      this.reminderCounter = 0;
      return { ...full, reminder_version: hash };
    }
    const domain = full['domain'] as Record<string, unknown> | undefined;
    return { preset: full['preset'], domain: domain?.['key'] ?? null, reminder_version: hash };
  }

  /** Главный конвейер исполнения инструмента. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolPayload> {
    const tabId = typeof args['tabId'] === 'number' ? (args['tabId'] as number) : null;
    let urlForReminder: string | null = tabId !== null ? (this.tabs.get(tabId)?.url ?? null) : (typeof args['url'] === 'string' ? args['url'] : null);
    let resolved: ResolvedDomain | null = urlForReminder ? this.policy.resolveDomain(urlForReminder) : null;

    const finish = (payload: ToolPayload): ToolPayload => {
      this.memory.journal({
        tool: name, args, result: payload, tabId, url: urlForReminder,
        // П2-4: полные args — только при journal_full_args: true (default off).
        ...(this.policy.journalFullArgs() ? { argsFull: this.sanitizedArgs(name, args, tabId) } : {}),
      });
      return payload;
    };
    // forceFull=true — на ошибках gating/пауз; =false — короткая форма по хэшу (П0-1).
    const reminder = (forceFull = true): Record<string, unknown> =>
      this.versionedReminder(this.memory.buildPolicyReminder(this.policy, resolved), forceFull);

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
      // act.batch: каждый шаг проходит check ПОШТУЧНО и АТОМАРНО в начале
      // (П1-2) — gated-шаг без гранта отклоняет весь пакет, partial execution
      // для gated недопустим. Одинаковые категории проверяются один раз.
      if (targetUrl) {
        for (const category of this.classifyAll(name, args, tabId, targetUrl)) {
          const check = this.policy.check(targetUrl, capability as 'read' | 'interact' | 'download' | null, category);
          if (check.decision === 'deny') return finish(this.fail(check.error_code, check.hint, reminder()));
          resolved = check.resolved;
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
      }

      // 7. Pacing (N6) для act.*. act.batch: ёмкость окна проверяется на весь
      // пакет заранее, сами шаги проходят beforeAction с малым jitter в execute.
      if (ACT_TOOLS.has(name)) {
        if (name === 'act.batch') {
          this.pacing.checkCapacity(Array.isArray(args['steps']) ? (args['steps'] as unknown[]).length : 0);
        } else {
          await this.pacing.beforeAction();
        }
      }

      // 8. Исполнение (с одноразовым авто-retry после STALE_REF — П1-3).
      let data: unknown;
      try {
        data = await this.execute(name, args, tabId);
      } catch (err) {
        data = await this.retryAfterStaleRef(name, args, tabId, err);
      }
      urlForReminder = (data && typeof data === 'object' && typeof (data as Record<string, unknown>)['url'] === 'string')
        ? (data as Record<string, unknown>)['url'] as string
        : urlForReminder;
      resolved = urlForReminder ? this.policy.resolveDomain(urlForReminder) : resolved;

      // 9. N15: контент страниц — untrusted.
      if ((PAGE_TOOLS.has(name) || name === 'page.scan') && data && typeof data === 'object') {
        (data as Record<string, unknown>)['untrusted_page_content'] = true;
      }

      // 10. N7: страховочная резка.
      const capped = capResponse(data);
      return finish({ ok: true, data: capped.data, hint: capped.hint, policy_reminder: reminder(false) });
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
      return finish(this.fail(code, hints[code] ?? (be.message ?? 'Внутренняя ошибка сервера'), reminder(), be.data));
    }
  }

  /**
   * П2-4: args для журнала при journal_full_args: true. Значения act.type в
   * login-формах (password-поле или gated-категория login) маскируются.
   */
  private sanitizedArgs(name: string, args: Record<string, unknown>, tabId: number | null): Record<string, unknown> {
    const clone = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
    const maskIfLogin = (tool: string, a: Record<string, unknown>): void => {
      if (tool !== 'act.type' || typeof a['text'] !== 'string' || tabId === null) return;
      const meta = this.snapshots.get(tabId)?.refs.get(String(a['ref'] ?? ''));
      if (meta?.attrs['type'] === 'password' || this.classifyAct(tool, a, tabId) === 'login') {
        a['text'] = '***';
      }
    };
    if (name === 'act.batch' && Array.isArray(clone['steps'])) {
      for (const s of clone['steps'] as Record<string, unknown>[]) {
        if (s && typeof s === 'object') maskIfLogin(`act.${String(s['do'] ?? '')}`, s);
      }
    } else {
      maskIfLogin(name, clone);
    }
    return clone;
  }

  private classify(name: string, args: Record<string, unknown>, tabId: number | null, targetUrl: string): GatedCategory | null {
    if (name === 'tab.open') return classifyUrl(targetUrl);
    if (tabId !== null) return this.classifyAct(name, args, tabId);
    return null;
  }

  /** Категория одного act-действия (используется и для шагов act.batch). */
  private classifyAct(name: string, args: Record<string, unknown>, tabId: number): GatedCategory | null {
    // click-by-text: элемента в снапшоте нет — классифицируем по самому тексту запроса.
    if (name === 'act.click' && !args['ref'] && args['text']) {
      return classifyElement({ ref: '', role: 'button', text: String(args['text']), href: null, attrs: {} });
    }
    if (name === 'act.click' || name === 'act.type' || name === 'act.select') {
      const ref = String(args['ref'] ?? '');
      const snap = this.snapshots.get(tabId);
      return classifyElement(snap?.refs.get(ref));
    }
    return null;
  }

  /**
   * Категории для policy-check (П1-2): для act.batch — поштучно по всем
   * шагам (уникальные), для остальных инструментов — одна категория.
   */
  private classifyAll(name: string, args: Record<string, unknown>, tabId: number | null, targetUrl: string): (GatedCategory | null)[] {
    if (name !== 'act.batch') return [this.classify(name, args, tabId, targetUrl)];
    const cats = new Set<GatedCategory | null>();
    if (tabId !== null && Array.isArray(args['steps'])) {
      for (const s of args['steps'] as Record<string, unknown>[]) {
        cats.add(this.classifyAct(`act.${String(s?.['do'] ?? '')}`, s ?? {}, tabId));
      }
    }
    return [...cats];
  }

  private describeAction(name: string, args: Record<string, unknown>): string {
    if (name === 'tab.open') return `Открыть ${String(args['url'] ?? '')}`;
    if (name === 'act.batch') {
      const n = Array.isArray(args['steps']) ? (args['steps'] as unknown[]).length : 0;
      return `act.batch (${n} шагов)`;
    }
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

  /**
   * П1-3: ровно ОДИН авто-retry после STALE_REF на act.* с ref: свежий снапшот
   * (кэш обновляется — иначе следующий page.snapshot дал бы ложный unchanged,
   * §5.5), поиск элемента по сохранённому text из кэша refs, повтор действия.
   * >1 кандидата — молча не выбираем (AMBIGUOUS с кандидатами, как click-by-text).
   * Gated: новый ref классифицируется заново; категория изменилась — отказ.
   */
  private async retryAfterStaleRef(name: string, args: Record<string, unknown>, tabId: number | null, err: unknown): Promise<unknown> {
    const be = err as Partial<BridgeError>;
    if (be.code !== 'STALE_REF' || !ACT_TOOLS.has(name) || tabId === null || !args['ref']) throw err;
    const meta = this.snapshots.get(tabId)?.refs.get(String(args['ref']));
    if (!meta || !meta.text) throw err;
    const origCategory = classifyElement(meta);

    const res = await this.transport.request('snapshot', { tabId }) as Record<string, unknown> & { snapshot?: string; url?: string };
    if (typeof res.snapshot !== 'string') throw err;
    const refs = parseSnapshotRefs(res.snapshot);
    this.snapshots.set(tabId, {
      text: res.snapshot, dom_hash: shortHash(res.snapshot), refs, url: res.url ?? '', scopeKey: '|',
    });

    let candidates = [...refs.values()].filter((m) => m.text === meta.text);
    if (candidates.length > 1) {
      const byRole = candidates.filter((m) => m.role === meta.role);
      if (byRole.length > 0) candidates = byRole;
    }
    if (candidates.length === 0) throw err; // элемента больше нет — честный STALE_REF
    if (candidates.length > 1) {
      throw new BridgeError('AMBIGUOUS',
        `авто-retry: текст "${meta.text}" совпал с несколькими элементами: ${candidates.map((c) => c.ref).join(', ')}. Сделай page.snapshot и укажи ref явно.`);
    }
    const newMeta = candidates[0];
    if (classifyElement(newMeta) !== origCategory) {
      throw new BridgeError('ACTION_DENIED',
        `авто-retry: элемент "${meta.text}" перенайден (${newMeta.ref}), но его gated-категория изменилась — действие НЕ выполнено. Сделай page.snapshot и повтори осознанно.`);
    }
    this.log(`core: авто-retry ${name} ${String(args['ref'])} → ${newMeta.ref}`);
    const data = await this.execute(name, { ...args, ref: newMeta.ref }, tabId);
    if (data && typeof data === 'object') {
      (data as Record<string, unknown>)['retried'] = true;
      (data as Record<string, unknown>)['new_ref'] = newMeta.ref;
    }
    return data;
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
          const scopeKey = `${String(args['scope'] ?? '')}|${String(args['selector'] ?? '')}`;
          const domHash = shortHash(res.snapshot);
          const cached = this.snapshots.get(tabId);
          // П0-3: страница не изменилась — компактный ответ вместо полного текста.
          // Кэш НЕ затираем: refs из него остаются валидными для act.*.
          if (cached && cached.dom_hash === domHash && cached.scopeKey === scopeKey) {
            return { unchanged: true, dom_hash: domHash, url: res.url ?? cached.url };
          }
          this.snapshots.set(tabId, { text: res.snapshot, dom_hash: domHash, refs: parseSnapshotRefs(res.snapshot), url: res.url ?? '', scopeKey });
        }
        if (tabId !== null && res.url) this.tabs.set(tabId, { url: res.url, title: res.title ?? '' });
        return res;
      }
      case 'page.extract':
        return this.pageCommand('extractMarkdown', tabId, { selector: args['selector'], images: args['images'], max_chars: args['max_chars'] });
      case 'page.find':
        return this.pageCommand('findText', tabId, { query: args['query'], role: args['role'] });
      case 'page.screenshot':
        return this.pageCommand('screenshot', tabId, {});
      case 'net.list':
        return this.transport.request('netList', { tabId });
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
      case 'act.batch':
        return this.executeBatch(tabId, args['steps']);
      case 'page.wait_for': {
        // П1-1: таймаут — не ошибка gating, а {condition_met:false}. Таймаут
        // транспорта ставим больше контентного, чтобы дождаться честный ответ.
        const timeoutMs = Math.min(Math.max(Number(args['timeout_ms']) || 10000, 500), 30000);
        return this.pageCommand('waitFor', tabId, {
          condition: args['condition'], state: args['state'], timeout_ms: timeoutMs,
        }, timeoutMs + 15000);
      }
      case 'page.scan':
        // П2-3: контентный дедлайн 45 с — транспортный таймаут больше.
        return this.pageCommand('scan', tabId, { max_screens: args['max_screens'] }, 55000);
      case 'file.download':
        return this.executeDownload(tabId, String(args['url'] ?? ''), args['name'] ? String(args['name']) : undefined);
      default:
        throw new BridgeError('INTERNAL', `неизвестный инструмент: ${name}`);
    }
  }

  /**
   * П1-2: пакет act-действий (≤10). Policy-check всех шагов уже прошёл в
   * callTool (атомарно, до старта). Между шагами — уменьшенный jitter
   * (0.3–0.8 c, НЕ нулевой: human-like pacing сохраняется), каждый шаг идёт
   * в окно 30 act/мин. Шаг получает тот же авто-retry после STALE_REF (П1-3).
   * Ответ — состояние после ПОСЛЕДНЕГО шага (один after-блок) + реестр шагов.
   * Падение шага → BATCH_STEP_FAILED с числом завершённых (partial execution
   * не скрываем).
   */
  private async executeBatch(tabId: number | null, stepsArg: unknown): Promise<unknown> {
    const steps = Array.isArray(stepsArg) ? (stepsArg as Record<string, unknown>[]) : [];
    const ALLOWED = new Set(['act.click', 'act.type', 'act.select', 'act.key']);
    const stepNames: string[] = [];
    for (const s of steps) {
      const doName = `act.${String(s?.['do'] ?? '')}`;
      if (!ALLOWED.has(doName)) {
        throw new BridgeError('INTERNAL', `act.batch: недопустимый шаг "${String(s?.['do'])}" (click|type|select|key)`);
      }
      stepNames.push(doName);
    }
    if (steps.length < 1 || steps.length > 10) throw new BridgeError('INTERNAL', 'act.batch: нужно 1..10 шагов');

    const done: Record<string, unknown>[] = [];
    let last: unknown = null;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i] ?? {};
      await this.pacing.beforeAction({ min_ms: 300, max_ms: 800 });
      try {
        last = await this.execute(stepNames[i], { ...s, tabId }, tabId);
      } catch (err) {
        try {
          last = await this.retryAfterStaleRef(stepNames[i], { ...s, tabId }, tabId, err);
        } catch (err2) {
          const be2 = err2 as Partial<BridgeError>;
          throw new BridgeError('BATCH_STEP_FAILED',
            `act.batch: шаг ${i + 1}/${steps.length} (${stepNames[i]}) не выполнен: ${be2.message ?? String(err2)}. Успешно завершено шагов: ${i}.`,
            { steps: done, batch_completed: i });
        }
      }
      done.push({ do: stepNames[i], ref: s['ref'] ?? null, ok: true });
    }
    const out: Record<string, unknown> = last && typeof last === 'object' ? { ...(last as Record<string, unknown>) } : {};
    out['steps'] = done;
    return out;
  }

  private async pageCommand(method: string, tabId: number | null, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const res = await this.transport.request(method, { tabId, ...params }, timeoutMs) as Record<string, unknown> & { url?: string; title?: string };
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
    ['page.snapshot', 'Семантический снапшот страницы (интерактивные элементы с ref-метками). Если страница не изменилась с прошлого снапшота — ответ {unchanged:true}, refs из прошлого снапшота остаются валидными', { tabId, scope: z.enum(['viewport', 'main', 'full']).optional(), selector: z.string().optional() }],
    ['page.extract', 'Чистый markdown содержимого страницы (div-суп — density-режим). images: "inline" (по умолчанию) | "manifest" | "off"; max_chars — лимит по границе абзаца (15000)', { tabId, selector: z.string().optional(), images: z.enum(['inline', 'manifest', 'off']).optional(), max_chars: z.number().optional() }],
    ['page.find', 'Поиск по тексту/роли без полного снапшота (≤20 совпадений)', { tabId, query: z.string(), role: z.string().optional() }],
    ['page.wait_for', 'Событийное ожидание условия (без polling снапшотами): текст/ref/url появился или исчез. Таймаут — не ошибка: {condition_met:false}. Один активный wait на вкладку', { tabId, condition: z.object({ text: z.string().optional(), ref: z.string().optional(), url_contains: z.string().optional() }).describe('условие: text ИЛИ ref ИЛИ url_contains'), state: z.enum(['appear', 'disappear', 'stale']).optional(), timeout_ms: z.number().max(30000).optional() }],
    ['page.screenshot', 'Скриншот вкладки (JPEG base64, ≤1280px)', { tabId }],
    ['net.list', 'Пассивный лог media-запросов вкладки (m3u8/mpd/media) — прямые URL потоков для скачивания', { tabId }],
    ['page.scan', 'Автоскролл ленты с агрегацией уникальных интерактивных элементов (refs живые). Стоп: 3 экрана без роста, ≤20 экранов, ≤45 с', { tabId, max_screens: z.number().max(20).optional() }],
    ['act.click', 'Клик по элементу (ref из снапшота ИЛИ text — атомарный поиск+клик по тексту, устойчив к STALE_REF)', { tabId, ref: ref.optional(), text: z.string().optional() }],
    ['act.type', 'Ввод текста в элемент', { tabId, ref, text: z.string(), clear: z.boolean().optional() }],
    ['act.select', 'Выбор значения в <select>', { tabId, ref, value: z.string() }],
    ['act.scroll', 'Скролл на dy пикселей или scrollIntoView к ref', { tabId, dy: z.number().optional(), ref: ref.optional() }],
    ['act.key', 'Нажатие клавиши (Enter, Tab, Escape, …)', { tabId, key: z.string() }],
    ['act.batch', 'Пакет до 10 действий (click/type/select/key) одним вызовом: единый policy-check в начале (gated-шаг без гранта отклоняет весь пакет), один after-блок в конце. Шаги учитываются в окне 30 act/мин', { tabId, steps: z.array(z.object({ do: z.enum(['click', 'type', 'select', 'key']), ref: ref.optional(), text: z.string().optional(), value: z.string().optional(), clear: z.boolean().optional(), key: z.string().optional() })).min(1).max(10) }],
    ['file.download', 'Скачать файл со страницы через браузерную сессию (WS-релей в downloads/). Большие файлы (>30 с релея) качают скрипты файл-REPL; при таймауте -32001 НЕ повторять вызов: проверить downloads/manifest.jsonl (status ok) — трансфер может завершиться в фоне. Повтор идентичного файла возвращает существующий (dedup), а не копию', { tabId, url: z.string(), name: z.string().optional() }],
    ['policy.status', 'Активный пресет, гранты, gated-правила, состояние пауз', {}],
    ['policy.request_preset', 'Запросить переключение пресета политики (требует подтверждения пользователя)', { name: z.string() }],
  ];

  for (const [name, description, shape] of defs) {
    server.registerTool(name, { description, inputSchema: shape }, async (args) => {
      const payload = await core.callTool(name, args as Record<string, unknown>);
      // П0-2: компактный JSON без indent — экономия токенов; формат снапшота
      // внутри data остаётся построчным текстом, читаемость не страдает.
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
    });
  }
  return server;
}
