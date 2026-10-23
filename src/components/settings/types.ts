import { TranslationKeys } from '../../i18n';

export type SettingsTabId =
  // App settings
  | 'general'
  | 'chat-models'
  | 'storage'
  // Service settings (7 items in exact order)
  | 'svc-model'
  | 'svc-kb'
  | 'svc-asr'
  | 'svc-tts'
  | 'svc-subtitles'
  | 'svc-translate'
  | 'svc-ocr';

export interface SettingsTabItem {
  id: SettingsTabId;
  labelKey: TranslationKeys;
  isService?: boolean;
}
