import Cocoa
import Carbon

class HotKeyManager {
    static let shared = HotKeyManager()
    private var hotKeyRef: EventHotKeyRef?
    var onTrigger: (() -> Void)?

    func register(keyCode: UInt32 = UInt32(kVK_Space), modifiers: UInt32 = UInt32(optionKey)) {
        let hotKeyID = EventHotKeyID(signature: OSType(0x54464643), id: 1) // 'TFFC'
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

            if status == noErr && hotKeyID.id == 1 {
                DispatchQueue.main.async {
                    HotKeyManager.shared.onTrigger?()
                }
            }
            return noErr
        }, 1, &eventType, nil, nil)

        RegisterEventHotKey(keyCode, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    func unregister() {
        if let ref = hotKeyRef {
            UnregisterEventHotKey(ref)
            hotKeyRef = nil
        }
    }
}
