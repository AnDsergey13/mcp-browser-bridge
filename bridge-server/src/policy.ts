// policy.ts — Policy engine (фаза 3 плана): пресеты → домены → capabilities,
// gating с hard_floor (N16), разовые session-гранты, hot-reload policy.yaml,
// аудит решений (N17) в memory/policy-audit.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

// 'eval' (L1.1): выполнение JS в MAIN world — мощный примитив (обходит
// action-модель gated), поэтому default confirm и рекомендация держать
// `eval: confirm` в hard_floor policy.yaml.
export type GatedCategory = 'pay' | 'login' | 'submit' | 'delete' | 'eval';
export type GatedDecision = 'auto' | 'confirm' | 'deny';
export type Capability = 'read' | 'interact' | 'download' | 'eval';

export const GATED_CATEGORIES: GatedCategory[] = ['pay', 'login', 'submit', 'delete', 'eval'];

// Сила решения: чем больше — тем безопаснее. hard_floor запрещает ослабление.
const STRENGTH: Record<GatedDecision, number> = { auto: 0, confirm: 1, deny: 2 };

export interface DomainGrant {
  capabilities: Capability[];
  gated: Partial<Record<GatedCategory, GatedDecision>>;
  source: 'preset' | 'session';
}

/** Session-грант (D4): привязан к браузеру-источнику; clientId undefined — для всех (back-compat вызовов без clientId). */
interface SessionGrant extends DomainGrant {
  clientId?: string;
}

export interface ResolvedDomain {
  key: string;
  capabilities: Capability[];
  gated: Record<GatedCategory, GatedDecision>;
  source: 'preset' | 'session';
}

export type CheckResult =
  | { decision: 'allow'; resolved: ResolvedDomain }
  | { decision: 'consent'; resolved: ResolvedDomain; category: GatedCategory }
  | { decision: 'deny'; resolved: ResolvedDomain | null; error_code: string; hint: string };

interface PolicyFile {
  version?: number;
  active_preset?: string;
  default?: string;
  gated_defaults?: Partial<Record<GatedCategory, GatedDecision>>;
  hard_floor?: Partial<Record<GatedCategory, GatedDecision>>;
  /** П2-4: журналировать полные args tool calls (default off; пароли маскируются). */
  journal_full_args?: boolean;
  pacing?: { min_delay_ms?: number; max_delay_ms?: number; max_actions_per_minute?: number };
  presets?: Record<string, {
    description?: string;
    allow_unsafe?: boolean;
    domains?: Record<string, {
      capabilities?: string[];
      gated?: Partial<Record<GatedCategory, GatedDecision>>;
      /** D4: clientId'ы браузеров, которым доступен домен; без поля — всем. */
      browsers?: string[];
    }>;
  }>;
}

export interface PolicyUpdateView {
  preset: string;
  match_patterns: string[];
  domains: Record<string, { capabilities: Capability[]; gated: Record<GatedCategory, GatedDecision>; source?: string }>;
  gated_defaults: Record<GatedCategory, GatedDecision>;
  version: number;
}

function isGatedDecision(v: unknown): v is GatedDecision {
  return v === 'auto' || v === 'confirm' || v === 'deny';
}

export class PolicyEngine {
  private policyPath: string;
  private memoryDir: string;
  private log: (msg: string) => void;
  private file: PolicyFile = {};
  private runtimePreset: string | null = null; // переключение из popup/агента (не перезаписывает yaml)
  // Ключ: `${clientId}\n${domain}` (per-browser изоляция, D4); clientId '' — грант для всех (вызовы без clientId).
  private sessionGrants = new Map<string, SessionGrant>();
  private allow10min = new Map<string, number>(); // "domain|category" → expiry ts
  private updateVersion = 0; // монотонный счётчик policy.update
  private watcher: fs.FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  onChange: ((view: PolicyUpdateView) => void) | null = null;

  constructor(opts: { policyPath: string; memoryDir: string; log?: (msg: string) => void }) {
    this.policyPath = opts.policyPath;
    this.memoryDir = opts.memoryDir;
    this.log = opts.log ?? (() => {});
  }

  load(): void {
    const raw = fs.readFileSync(this.policyPath, 'utf8');
    const parsed = YAML.parse(raw) as PolicyFile | null;
    this.file = parsed ?? {};
    if (this.file.version !== 2) {
      this.log(`policy: warning: ожидается version: 2, получено ${this.file.version}`);
    }
    // Если рантим-пресет исчез из файла — откат на active_preset из файла.
    if (this.runtimePreset && !this.file.presets?.[this.runtimePreset]) {
      this.log(`policy: runtime-пресет "${this.runtimePreset}" отсутствует после reload, откат`);
      this.runtimePreset = null;
    }
    this.updateVersion++;
    this.log(`policy: загружена, пресет "${this.activePreset()}", version=${this.updateVersion}`);
  }

  startWatch(): void {
    this.stopWatch();
    try {
      this.watcher = fs.watch(this.policyPath, () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          try {
            this.load();
            this.emitChange();
          } catch (err) {
            this.log(`policy: ошибка hot-reload: ${(err as Error).message}`);
            // Файл мог быть заменён атомарно (rename) — переподпишемся.
            this.startWatch();
          }
        }, 100);
      });
    } catch (err) {
      this.log(`policy: не удалось подписаться на ${this.policyPath}: ${(err as Error).message}`);
    }
  }

  stopWatch(): void {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.reloadTimer) { clearTimeout(this.reloadTimer); this.reloadTimer = null; }
  }

  private emitChange(): void {
    if (this.onChange) this.onChange(this.buildPolicyUpdate());
  }

  // ---- пресеты ----

  presetNames(): string[] {
    return Object.keys(this.file.presets ?? {});
  }

  activePreset(): string {
    if (this.runtimePreset) return this.runtimePreset;
    return this.file.active_preset ?? this.presetNames()[0] ?? '';
  }

  presetDescription(name?: string): string {
    const p = this.file.presets?.[name ?? this.activePreset()];
    return p?.description ?? '';
  }

  presetAllowsUnsafe(name?: string): boolean {
    const p = this.file.presets?.[name ?? this.activePreset()];
    return p?.allow_unsafe === true;
  }

  hasPreset(name: string): boolean {
    return Boolean(this.file.presets?.[name]);
  }

  /** Переключение пресета (popup user gesture или агент после consent). Не перезаписывает yaml. */
  setActivePreset(name: string): void {
    if (!this.hasPreset(name)) throw new Error(`unknown preset: ${name}`);
    this.runtimePreset = name;
    this.updateVersion++;
    this.audit({ kind: 'override', decision: 'preset_switch', preset: name, reason: 'user/agent request' });
    this.emitChange();
  }

  // ---- разовые гранты ----

  /**
   * Разовый грант с REPLACE-семантикой: popup шлёт полный набор capabilities
   * (чекбоксы), поэтому повторная выдача = редактирование — capability можно
   * и снять. Пресетные домены не перезаписываются: session-грант лишь
   * дополняет/переопределяет поверх пресета (grantFor мержит).
   * D4: грант привязан к браузеру-источнику (clientId); без clientId — для всех.
   */
  setSessionGrant(domain: string, capabilities: Capability[], clientId?: string): void {
    const key = this.sessionKey(clientId, domain);
    const existing = this.sessionGrants.get(key);
    const caps = [...new Set(capabilities)];
    this.sessionGrants.set(key, {
      capabilities: caps,
      gated: existing?.gated ?? {},
      source: 'session',
      clientId,
    });
    this.updateVersion++;
    this.audit({ kind: 'grant', domain, browser: clientId ?? null, decision: existing ? 'session_grant_update' : 'session_grant', capabilities: caps });
    this.emitChange();
  }

  /**
   * Отзыв разового гранта (жест пользователя в popup). Только session-гранты:
   * пресетные домены управляются правкой policy.yaml. Возвращает false, если
   * session-гранта на этот домен у этого браузера не было.
   */
  removeSessionGrant(domain: string, clientId?: string): boolean {
    if (!this.sessionGrants.delete(this.sessionKey(clientId, domain))) return false;
    this.updateVersion++;
    this.audit({ kind: 'grant', domain, browser: clientId ?? null, decision: 'session_revoke' });
    this.emitChange();
    return true;
  }

  private sessionKey(clientId: string | undefined, domain: string): string {
    return `${clientId ?? ''}\n${domain}`;
  }

  // ---- домены ----

  /** Ключи вида "host" или "host:port". "host" матчит host и его поддомены (любой порт). */
  private matchKey(url: string, clientId?: string): string | null {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    const hostname = u.hostname.toLowerCase();
    const port = u.port; // '' для дефолтных портов схемы
    const keys = this.allDomainKeys(clientId);
    // 1) точный host:port
    if (port) {
      const hp = `${hostname}:${port}`;
      if (keys.has(hp)) return hp;
    }
    // 2) точный host / поддомен для ключа без порта
    for (const key of keys) {
      if (key.includes(':')) continue;
      const kh = key.toLowerCase();
      if (hostname === kh || hostname.endsWith('.' + kh)) return key;
    }
    return null;
  }

  /** Домен пресета виден клиенту? Поля browsers нет — всем; clientId undefined — старое поведение (всем). */
  private presetVisible(key: string, clientId?: string): boolean {
    if (clientId === undefined) return true;
    const b = this.file.presets?.[this.activePreset()]?.domains?.[key]?.browsers;
    return !b || b.includes(clientId);
  }

  private sessionVisible(grant: SessionGrant, clientId?: string): boolean {
    if (clientId === undefined) return true;
    return !grant.clientId || grant.clientId === clientId;
  }

  private allDomainKeys(clientId?: string): Set<string> {
    const keys = new Set<string>();
    const preset = this.file.presets?.[this.activePreset()];
    for (const k of Object.keys(preset?.domains ?? {})) {
      if (this.presetVisible(k, clientId)) keys.add(k);
    }
    for (const [k, g] of this.sessionGrants) {
      if (this.sessionVisible(g, clientId)) keys.add(k.slice(k.indexOf('\n') + 1));
    }
    return keys;
  }

  /** Session-гранты домена, видимые клиенту (обычно 0–1: грант per (clientId, domain)). */
  private sessionGrantsFor(key: string, clientId?: string): SessionGrant[] {
    const out: SessionGrant[] = [];
    for (const [k, g] of this.sessionGrants) {
      if (k.slice(k.indexOf('\n') + 1) === key && this.sessionVisible(g, clientId)) out.push(g);
    }
    return out;
  }

  private grantFor(key: string, clientId?: string): DomainGrant | null {
    const preset = this.file.presets?.[this.activePreset()];
    const fromPreset = this.presetVisible(key, clientId) ? preset?.domains?.[key] : undefined;
    const sessions = this.sessionGrantsFor(key, clientId);
    if (!fromPreset && sessions.length === 0) return null;
    const caps = new Set<Capability>((fromPreset?.capabilities ?? []) as Capability[]);
    const gated: Partial<Record<GatedCategory, GatedDecision>> = { ...(fromPreset?.gated ?? {}) };
    for (const s of sessions) {
      for (const c of s.capabilities) caps.add(c);
      Object.assign(gated, s.gated);
    }
    return {
      capabilities: [...caps],
      gated,
      source: sessions.length > 0 && !fromPreset ? 'session' : 'preset',
    };
  }

  gatedDefaults(): Record<GatedCategory, GatedDecision> {
    const d = this.file.gated_defaults ?? {};
    const out = {} as Record<GatedCategory, GatedDecision>;
    for (const c of GATED_CATEGORIES) out[c] = isGatedDecision(d[c]) ? d[c]! : 'confirm';
    return out;
  }

  /** Эффективное gated-решение для ключа домена с учётом дефолтов и hard_floor (N16). */
  private resolveGated(key: string, grant: DomainGrant): Record<GatedCategory, GatedDecision> {
    const defaults = this.gatedDefaults();
    const floor = this.file.hard_floor ?? {};
    const allowUnsafe = this.presetAllowsUnsafe();
    const out = {} as Record<GatedCategory, GatedDecision>;
    for (const c of GATED_CATEGORIES) {
      let dec: GatedDecision = isGatedDecision(grant.gated[c]) ? grant.gated[c]! : defaults[c];
      const f = floor[c];
      if (f && !allowUnsafe && STRENGTH[dec] < STRENGTH[f]) {
        this.audit({
          kind: 'override', domain: key, category: c,
          decision: f, reason: `hard_floor: ${dec} ослаблено до ${f} (в пресете нет allow_unsafe: true)`,
        });
        dec = f;
      }
      out[c] = dec;
    }
    return out;
  }

  resolveDomain(url: string, clientId?: string): ResolvedDomain | null {
    const key = this.matchKey(url, clientId);
    if (!key) return null;
    const grant = this.grantFor(key, clientId);
    if (!grant) return null;
    return { key, capabilities: grant.capabilities, gated: this.resolveGated(key, grant), source: grant.source };
  }

  // ---- проверка команды ----

  /**
   * D4: clientId — браузер, от имени которого идёт команда. Домен с полем
   * browsers, не включающим clientId, → deny как DOMAIN_NOT_ALLOWED.
   * clientId undefined — старое поведение без per-browser фильтра.
   */
  check(url: string, capability: Capability | null, category: GatedCategory | null, clientId?: string): CheckResult {
    const resolved = this.resolveDomain(url, clientId);
    if (!resolved) {
      // Домен грантован, но не этому браузеру — подсказка честнее общей.
      const globally = clientId !== undefined ? this.resolveDomain(url) : null;
      const hint = globally
        ? `Домен ${globally.key} грантован другому браузеру (не "${clientId}"). Попроси пользователя выдать грант через popup этого браузера или добавь "${clientId}" в browsers домена в policy.yaml.`
        : `Домен ${hostOf(url)} не входит в активный пресет "${this.activePreset()}". Попроси пользователя добавить грант через popup расширения или сменить пресет (policy.request_preset).`;
      this.audit({ kind: 'deny', domain: hostOf(url), browser: clientId ?? null, capability, decision: 'DOMAIN_NOT_ALLOWED' });
      return { decision: 'deny', resolved: null, error_code: 'DOMAIN_NOT_ALLOWED', hint };
    }
    if (capability && !resolved.capabilities.includes(capability)) {
      this.audit({ kind: 'deny', domain: resolved.key, capability, decision: 'CAPABILITY_DENIED' });
      return {
        decision: 'deny', resolved, error_code: 'CAPABILITY_DENIED',
        hint: `Для домена ${resolved.key} не выдана capability "${capability}" (есть: ${resolved.capabilities.join(', ')}).`,
      };
    }
    if (category) {
      const dec = resolved.gated[category];
      if (dec === 'deny') {
        this.audit({ kind: 'deny', domain: resolved.key, category, decision: 'ACTION_DENIED', reason: 'gated: deny' });
        return {
          decision: 'deny', resolved, error_code: 'ACTION_DENIED',
          hint: `Действие категории "${category}" запрещено политикой для ${resolved.key}.`,
        };
      }
      if (dec === 'confirm') {
        const cacheKey = `${resolved.key}|${category}`;
        const expiry = this.allow10min.get(cacheKey);
        if (expiry && expiry > Date.now()) {
          this.audit({ kind: 'grant', domain: resolved.key, category, decision: 'allow_10min_cache_hit' });
          return { decision: 'allow', resolved };
        }
        return { decision: 'consent', resolved, category };
      }
      // auto
      this.audit({ kind: 'grant', domain: resolved.key, category, decision: 'auto' });
      return { decision: 'allow', resolved };
    }
    this.audit({ kind: 'grant', domain: resolved.key, capability, decision: 'allow' });
    return { decision: 'allow', resolved };
  }

  cacheAllow10min(domainKey: string, category: GatedCategory): void {
    this.allow10min.set(`${domainKey}|${category}`, Date.now() + 10 * 60 * 1000);
    this.audit({ kind: 'grant', domain: domainKey, category, decision: 'allow_10min_cached', ttl_ms: 600000 });
  }

  // ---- pacing (N6), читается из текущей политики (hot-reload aware) ----

  /** П2-4: флаг журналирования полных args (default off, hot-reload aware). */
  journalFullArgs(): boolean {
    return this.file.journal_full_args === true;
  }

  pacing(): { min_delay_ms: number; max_delay_ms: number; max_actions_per_minute: number } {
    const g = this.file.pacing ?? {};
    // per-preset переопределение: presets.<name>.pacing поверх глобального
    const preset = this.file.presets?.[this.activePreset()] as Record<string, unknown> | undefined;
    const local = (preset?.['pacing'] ?? {}) as Partial<NonNullable<PolicyFile['pacing']>>;
    const p = { ...g, ...local };
    return {
      min_delay_ms: p.min_delay_ms ?? 400,
      max_delay_ms: p.max_delay_ms ?? 2500,
      max_actions_per_minute: p.max_actions_per_minute ?? 30,
    };
  }

  // ---- вид для расширения ----

  /** Вид для расширения; с clientId — только домены этого браузера (D4), без — все (старое поведение). */
  buildPolicyUpdate(clientId?: string): PolicyUpdateView {
    const domains: PolicyUpdateView['domains'] = {};
    const patterns: string[] = [];
    for (const key of this.allDomainKeys(clientId)) {
      const grant = this.grantFor(key, clientId);
      if (!grant) continue;
      domains[key] = {
        capabilities: grant.capabilities,
        gated: this.resolveGated(key, grant),
        source: grant.source,
      };
      // match patterns не поддерживают порт (MDN): "*://host:8080/*" — невалидный
      // паттерн, contentScripts.register падает. Порт выкидываем (точную проверку
      // host:port всё равно делает сервер на каждую команду), "*://*.host/*"
      // покрывает и сам host, и поддомены. Для IP-литералов — только точный паттерн.
      const hostOnly = key.split(':')[0];
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostOnly);
      if (isIp || !hostOnly.includes('.')) patterns.push(`*://${hostOnly}/*`);
      else patterns.push(`*://*.${hostOnly}/*`);
    }
    return {
      preset: this.activePreset(),
      match_patterns: patterns,
      domains,
      gated_defaults: this.gatedDefaults(),
      version: this.updateVersion,
    };
  }

  // ---- аудит (N17) ----

  audit(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(this.memoryDir, { recursive: true });
      const line = JSON.stringify({ ts: new Date().toISOString(), preset: this.activePreset(), ...entry });
      fs.appendFileSync(path.join(this.memoryDir, 'policy-audit.jsonl'), line + '\n');
    } catch (err) {
      this.log(`policy: ошибка записи аудита: ${(err as Error).message}`);
    }
  }
}

export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url;
  }
}

/** Имя файла плейбука домена в memory/domains/ (файлово-безопасное). */
export function domainFileName(domainKey: string): string {
  return domainKey.replace(/[^a-zA-Z0-9.-]/g, '_') + '.md';
}
