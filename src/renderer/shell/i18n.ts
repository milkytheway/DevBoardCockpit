import { createContext, useContext } from 'react';

/**
 * **Interface localisation** ✓
 *
 * ── What this file is ──
 *
 * The mechanism only: the locale type, the storage, the React context and
 * the lookup function. The text itself lives next to the component that
 * uses it, so that changing a label does not mean opening a file
 * elsewhere.
 *
 * ── Why the mechanism and not a single table ──
 *
 * A single table would put every string in one file, which means every
 * change to any screen touches that file, and two people working on
 * different screens collide on it. Keeping the strings next to their
 * component keeps the change local.
 *
 * ── How a component declares its strings ──
 *
 * ```ts
 * const strings = {
 *   title: { 'zh-Hans': '接板向导', en: 'Board setup wizard' },
 * };
 * ```
 *
 * `useT` returns the string for the active locale.
 */

/** The locales the interface offers. */
export type Locale = 'zh-Hans' | 'en';

/** Every locale, in the order they appear in the language selector. */
export const LOCALES: readonly Locale[] = ['zh-Hans', 'en'];

/** The locale names, written in the language they name. */
export const LOCALE_NAMES: Record<Locale, string> = {
  'zh-Hans': '中文',
  en: 'English',
};

const STORAGE_KEY = 'devboard.locale';

/** The locale to use when nothing has been stored, or the stored value is unknown. */
export const DEFAULT_LOCALE: Locale = 'zh-Hans';

/** Read the stored locale. Falls back to the default. */
export function readStoredLocale(): Locale {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === 'en' ? 'en' : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** Store the locale. */
export function storeLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Local storage can be unavailable in hardened environments. The locale
    // is cosmetic, so failing to store it is not worth reporting.
  }
}

/** A string declared for every locale. */
export interface Localised {
  'zh-Hans': string;
  en: string;
}

/**
 * Pick the string for a locale.
 *
 * A missing translation falls back to Simplified Chinese rather than to an
 * empty string. An empty label reads as a rendering fault; the Chinese text
 * reads as untranslated, which is the honest outcome.
 */
export function pick(text: Localised | undefined, locale: Locale): string {
  if (text === undefined) return '';
  const value = text[locale];
  if (typeof value === 'string' && value.length > 0) return value;
  return text['zh-Hans'];
}

/** The active locale. */
export const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

/**
 * Replace the placeholders in a translated string.
 *
 * `{name}` becomes the value passed under that key. A placeholder with no
 * matching value is left in place rather than replaced by an empty string,
 * because an empty hole in a sentence reads as a rendering fault.
 */
export function interpolate(text: string, values?: Record<string, string | number>): string {
  if (values === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * The lookup function for the active locale.
 *
 * ```ts
 * const t = useT();
 * return <h1>{t(strings.title)}</h1>;
 * return <h1>{t(strings.greeting, { name })}</h1>;
 * ```
 */
export function useT(): (text: Localised, values?: Record<string, string | number>) => string {
  const locale = useContext(LocaleContext);
  return (text: Localised, values?: Record<string, string | number>) =>
    interpolate(pick(text, locale), values);
}

/**
 * The active locale, for the cases where the text is chosen outside the
 * lookup: sorting by a label, or putting a label into an attribute that
 * already contains other text.
 */
export function useLocale(): Locale {
  return useContext(LocaleContext);
}
