// compress.ts — N7: страховочная резка ответов >20KB.
// Урезается самое длинное строковое поле; в hint — код RESPONSE_TOO_LARGE
// и подсказка «сузь селектор/область».
// П0-5: data_jpeg_base64 (page.screenshot) из обрезки ИСКЛЮЧЁН — обрубок
// base64 бесполезен. Поле не участвует в подсчёте лимита; выше жёсткого
// потолка SCREENSHOT_MAX — честная ошибка SCREENSHOT_TOO_LARGE вместо куска.
const LIMIT = 20 * 1024;
const SCREENSHOT_KEY = 'data_jpeg_base64';
const SCREENSHOT_MAX = 1_500_000; // символов base64 (1280px/q70 заметно меньше)

export interface CappedResult {
  data: unknown;
  truncated: boolean;
  hint: string | null;
}

function findLongestString(obj: unknown, best: { path: string[]; value: string }): { path: string[]; value: string } {
  if (typeof obj === 'string') {
    return obj.length > best.value.length ? { path: best.path, value: obj } : best;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const cand = findLongestString(obj[i], { path: [...best.path, String(i)], value: best.value });
      if (cand.value.length > best.value.length) best = { path: cand.path, value: cand.value };
    }
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const cand = findLongestString(v, { path: [...best.path, k], value: best.value });
      if (cand.value.length > best.value.length) best = { path: cand.path, value: cand.value };
    }
  }
  return best;
}

function setByPath(obj: unknown, path: string[], value: unknown): void {
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]] as Record<string, unknown>;
  cur[path[path.length - 1]] = value;
}

export function capResponse(data: unknown, limit: number = LIMIT): CappedResult {
  // П0-5: скриншот обрабатываем отдельно — base64 не режем никогда.
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const shot = obj[SCREENSHOT_KEY];
    if (typeof shot === 'string') {
      if (shot.length > SCREENSHOT_MAX) {
        const rest = { ...obj };
        delete rest[SCREENSHOT_KEY];
        return {
          data: { ...rest, error: 'SCREENSHOT_TOO_LARGE', bytes_base64: shot.length },
          truncated: true,
          hint: 'SCREENSHOT_TOO_LARGE: скриншот даже после даунскейла ≤1280px/q70 превысил серверный потолок — base64 не отдан (обрубок бесполезен). Работай через page.snapshot/page.find.',
        };
      }
      // base64 не участвует в лимите и в поиске «самой длинной строки».
      const rest = { ...obj };
      delete rest[SCREENSHOT_KEY];
      const cappedRest = capResponse(rest, limit);
      if (!cappedRest.truncated) return { data, truncated: false, hint: null };
      return {
        data: { ...(cappedRest.data as Record<string, unknown>), [SCREENSHOT_KEY]: shot },
        truncated: true,
        hint: cappedRest.hint,
      };
    }
  }

  const serialized = JSON.stringify(data);
  if (serialized.length <= limit) return { data, truncated: false, hint: null };

  // Работаем на глубокой копии, исходный ответ не портим.
  const copy = JSON.parse(serialized) as unknown;
  const overshoot = serialized.length - limit;
  const longest = findLongestString(copy, { path: [], value: '' });
  if (longest.path.length > 0 && longest.value.length > overshoot + 256) {
    const keep = longest.value.length - overshoot - 256;
    setByPath(copy, longest.path, longest.value.slice(0, Math.max(keep, 1024)) + '\n… [RESPONSE_TOO_LARGE: обрезано сервером]');
  } else {
    // Длинной строки нет — отдаём радикально урезанное представление.
    return {
      data: { truncated_preview: serialized.slice(0, limit - 256), note: 'RESPONSE_TOO_LARGE' },
      truncated: true,
      hint: hintText(),
    };
  }
  if (copy && typeof copy === 'object' && !Array.isArray(copy)) {
    (copy as Record<string, unknown>)['truncated'] = true;
  }
  return { data: copy, truncated: true, hint: hintText() };
}

function hintText(): string {
  return 'RESPONSE_TOO_LARGE: ответ превышал 20KB и был урезан сервером — сузь селектор/область (selector, scope:"viewport"|"main") или используй page.find.';
}
