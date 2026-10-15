import Cocoa
import Carbon

class HotKeyManager {
    static let shared = HotKeyManager()
    private var spotlightHotKeyRef: EventHotKeyRef?
    private var translatorHotKeyRef: EventHotKeyRef?
    private var isHandlerInstalled = false

    var onTrigger: (() -> Void)?
    var onTranslatorTrigger: (() -> Void)?

    func register() {
        if !isHandlerInstalled {
            var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))

            InstallEventHandler(GetApplicationEventTarget(), { (_, theEvent, _) -> OSStatus in
                var hotKeyID = EventHotKeyID()
                let status = GetEventParameter(
                    theEvent,
                    EventParamName(kEventParamDirectObject),
                    EventParamType(typeEventHotKeyID),
                    nil,
                    MemoryLayout<EventHotKeyID>.size,
                    nil,
                    &hotKeyID
                )

                if status == noErr {
                    if hotKeyID.id == 1 {
                        DispatchQueue.main.async {
                            HotKeyManager.shared.onTrigger?()
                        }
                    } else if hotKeyID.id == 2 {
                        DispatchQueue.main.async {
                            HotKeyManager.shared.onTranslatorTrigger?()
                        }
                    }
                }
                return noErr
            }, 1, &eventType, nil, nil)

            isHandlerInstalled = true
        }

        // 1. Option + Space -> AI 对话小窗口 (Spotlight)
        let spotlightID = EventHotKeyID(signature: OSType(0x54464643), id: 1) // 'TFFC'
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), spotlightID, GetApplicationEventTarget(), 0, &spotlightHotKeyRef)

        // 2. Control + Space -> 快捷翻译框 (Translator)
        let translatorID = EventHotKeyID(signature: OSType(0x54464643), id: 2)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey), translatorID, GetApplicationEventTarget(), 0, &translatorHotKeyRef)
    }

    func unregister() {
        if let ref = spotlightHotKeyRef {
            UnregisterEventHotKey(ref)
            spotlightHotKeyRef = nil
        }
        if let ref = translatorHotKeyRef {
            UnregisterEventHotKey(ref)
            translatorHotKeyRef = nil
        }
    }
}
