// classifier.ts — классификация команды в gated-категорию (pay/login/submit/delete)
// по URL-паттернам и метаданным target-элемента из последнего снапшота вкладки.
import type { GatedCategory } from './policy.ts';

export interface ElementMeta {
  ref: string;
  role: string;             // link | button | textbox | select | checkbox | ...
  text: string;             // подпись/текст элемента (первый quoted-литерал)
  href: string | null;      // для link: "→ /path"
  attrs: Record<string, string>; // name=..., type=..., ...
}

const URL_PAY = /checkout|payment/i;
const URL_LOGIN = /login|signin/i;
const TEXT_PAY = /оплат|купить|оформить|pay|checkout|order/i;
const TEXT_DELETE = /удалить|отпис|delete|remove|unsubscribe/i;

/** Разбор строк снапшота вида `[e3] button "Войти" type=submit` в карту ref→метаданные. */
export function parseSnapshotRefs(snapshotText: string): Map<string, ElementMeta> {
  const refs = new Map<string, ElementMeta>();
  for (const line of snapshotText.split('\n')) {
    const m = /^\s*\[(e\d+)\]\s+([a-zA-Z-]+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, ref, role, rest] = m;
    const meta: ElementMeta = { ref, role, text: '', href: null, attrs: {} };
    const hrefM = /→\s*(\S+)/.exec(rest);
    if (hrefM) meta.href = hrefM[1];
    const textM = /"([^"]*)"/.exec(rest);
    if (textM) meta.text = textM[1];
    // атрибуты key=value (value — слово или "quoted")
    const attrRe = /([a-zA-Z-]+)=("([^"]*)"|\S+)/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(rest)) !== null) {
      meta.attrs[am[1]] = am[3] !== undefined ? am[3] : am[2];
    }
    refs.set(ref, meta);
  }
  return refs;
}

/** Классификация по целевому URL (tab.open / navigate). */
export function classifyUrl(url: string): GatedCategory | null {
  if (URL_PAY.test(url)) return 'pay';
  if (URL_LOGIN.test(url)) return 'login';
  return null;
}

/** Классификация по метаданным элемента (click/type/select по ref). */
export function classifyElement(meta: ElementMeta | null | undefined): GatedCategory | null {
  if (!meta) return null;
  if (meta.attrs['type'] === 'password') return 'login';
  const hay = `${meta.text} ${meta.href ?? ''}`;
  if (TEXT_PAY.test(hay)) return 'pay';
  if (TEXT_DELETE.test(hay)) return 'delete';
  if (meta.href && URL_PAY.test(meta.href)) return 'pay';
  if (meta.href && URL_LOGIN.test(meta.href)) return 'login';
  // submit-кнопка формы
  if ((meta.role === 'button' || meta.role === 'input' || meta.role === 'textbox') && meta.attrs['type'] === 'submit') {
    return 'submit';
  }
  return null;
}
