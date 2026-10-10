// classifier.ts — классификация команды в gated-категорию (pay/login/submit/delete)
// по URL-паттернам и метаданным target-элемента из последнего снапшота вкладки.
import type { GatedCategory } from './policy.ts';

export interface ElementMeta {
  ref: string;
  role: string;             // link | button | textbox | select | checkbox | ...
  text: string;             // подпись/текст элемента (первый quoted-литерал, видимый)
  aria: string | null;      // Д2: [aria: "…"] — aria-label при расхождении с видимым
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
    // П1-5: свёрнутая группа `[e12..e61] button "Купить" ×50` — раскрываем
    // диапазон: refs выданы всем элементам, classify/stale-retry обязаны их
    // видеть (иначе клик по середине диапазона обходил бы gated-категорию).
    const range = /^\s*\[e(\d+)\.\.e(\d+)\]\s+([a-zA-Z-]+)\s*(.*)$/.exec(line);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to >= from && to - from <= 1000) {
        for (let n = from; n <= to; n++) {
          refs.set(`e${n}`, parseRefMeta(`e${n}`, range[3], range[4]));
        }
      }
      continue;
    }
    const m = /^\s*\[(e\d+)\]\s+([a-zA-Z-]+)\s*(.*)$/.exec(line);
    if (!m) continue;
    refs.set(m[1], parseRefMeta(m[1], m[2], m[3]));
  }
  return refs;
}

function parseRefMeta(ref: string, role: string, rest: string): ElementMeta {
  const meta: ElementMeta = { ref, role, text: '', aria: null, href: null, attrs: {} };
  const hrefM = /→\s*(\S+)/.exec(rest);
  if (hrefM) meta.href = hrefM[1];
  const textM = /"([^"]*)"/.exec(rest);
  if (textM) meta.text = textM[1];
  // Д2: маркер расхождения [aria: "…"] — aria-текст тоже идёт в классификацию.
  const ariaM = /\[aria:\s*"([^"]*)"\]/.exec(rest);
  if (ariaM) meta.aria = ariaM[1];
  // атрибуты key=value (value — слово или "quoted")
  const attrRe = /([a-zA-Z-]+)=("([^"]*)"|\S+)/g;
  let am: RegExpExecArray | null;
  while ((am = attrRe.exec(rest)) !== null) {
    meta.attrs[am[1]] = am[3] !== undefined ? am[3] : am[2];
  }
  return meta;
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
  // Д2: gated-паттерны ищем и в видимом тексте, и в aria-маркере —
  // расхождение «кнопка говорит одно, aria другое» не должно обходить сеть.
  const hay = `${meta.text} ${meta.aria ?? ''} ${meta.href ?? ''}`;
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
