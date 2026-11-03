import { TranslationKeys } from '../../i18n';

export type SettingsTabId =
  // App settings
  | 'general'
  | 'chat-models'
  | 'storage'
  // Service settings (8 items in exact order)
  | 'svc-model'
  | 'svc-kb'
  | 'svc-asr'
  | 'svc-tts'
  | 'svc-subtitles'
  | 'svc-translate'
  | 'svc-ocr'
  | 'svc-scene3d';

export interface SettingsTabItem {
  id: SettingsTabId;
  labelKey: TranslationKeys;
  isService?: boolean;
}
