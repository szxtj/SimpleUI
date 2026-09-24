import React, { createContext, useContext, useMemo } from 'react';
import { translations, TranslationKeys, Language, formatArticleCount } from './translations';

export { formatArticleCount, translations };
export type { Language, TranslationKeys };
export type LanguagePreference = 'system' | 'zh' | 'en';

interface I18nContextType {
  lang: Language;
  preference: LanguagePreference;
  t: (key: TranslationKeys) => string;
}

const I18nContext = createContext<I18nContextType>({
  lang: 'zh',
  preference: 'system',
  t: (key) => translations.zh[key] || key,
});

export function resolveLanguage(preference: LanguagePreference = 'system'): Language {
  if (preference === 'zh' || preference === 'en') {
    return preference;
  }
  // System detection
  if (typeof navigator !== 'undefined' && navigator.language) {
    const navLang = navigator.language.toLowerCase();
    if (navLang.startsWith('zh')) {
      return 'zh';
    }
  }
  return 'en';
}

interface I18nProviderProps {
  preference?: LanguagePreference;
  children: React.ReactNode;
}

export const I18nProvider: React.FC<I18nProviderProps> = ({
  preference = 'system',
  children,
}) => {
  const lang = useMemo(() => resolveLanguage(preference), [preference]);

  const value = useMemo<I18nContextType>(() => {
    return {
      lang,
      preference,
      t: (key: TranslationKeys) => {
        const dict = translations[lang] || translations.zh;
        return dict[key] || translations.zh[key] || key;
      },
    };
  }, [lang, preference]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nContextType {
  return useContext(I18nContext);
}
