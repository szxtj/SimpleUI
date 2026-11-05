import AppKit
import Foundation
import UniformTypeIdentifiers

/// 「复制文本快速翻译」的剪贴板准入策略。
///
/// 设计约束（2026-11-05，11-05 晚修正）：
///   1. 只认**普通文字**：剪贴板首项必须声明一份纯文本表示，且该表示的内容是普通文字。
///      **不能只看 `types.first`** —— 实测浏览器 / Word / Notes / WKWebView 用 ⌘C 或自带复制按钮
///      复制文字时，`public.html` / `public.rtf` 常常排在 `public.utf8-plain-text` 前面，
///      但用户复制的仍然是文字；旧版按「首项首要类型」判定会把这些全误杀。
///      类型顺序由来源 App 决定，不是内容性质的判据。
///   2. 真正「不是普通文字」的剪贴板用**结构性**判据排除：首项一旦声明图片 / 音视频 /
///      PDF / 文件 URL / 带附件 RTFD，说明用户复制的是对象而非文字，纯文本只是文件名或 URL 兜底，
///      一律不读。刻意**不排除** RTF / HTML：它们是复制文字时的常见伴随表示。
///      读取仍按首项自己声明的那个纯文本类型取原始字符串，不走 AppKit 的 RTF/HTML 自动转换。
///   3. 内容级过滤：空文本、控制字符/二进制残留、单个链接或 data URI、长串 base64、
///      超长文本，全部**整体忽略**（不截断、不改写原文）。
///   4. 任何一步不通过都返回 nil；调用方据此**完全不改动 inputText / outputText**，
///      窗口保持上一次翻译的内容，绝不置空。
enum TranslationClipboard {
    /// 由前端 `setTranslatorConfig` 桥写入；键不存在时 `bool(forKey:)` 为 false —— 默认关闭。
    static let quickTranslateEnabledKey = "simpleui_translator_clipboard_quick_translate"

    /// 允许的纯文本 UTI。
    /// 刻意不含 `public.text`：它是 RTF / HTML 的父类型，放进来等于放过富文本。
    private static let plainTextTypes: Set<String> = [
        NSPasteboard.PasteboardType.string.rawValue, // public.utf8-plain-text
        "public.utf16-plain-text",
        "NSStringPboardType", // 旧版 AppKit 纯文本
        "com.apple.traditional-mac-plain-text", // TEXT（MacRoman 纯文本）
    ]

    /// 首项声明了这些类型 = 复制的是「对象」而不是文字。用 UTType 的 conforms 判定，
    /// 覆盖各来源 App 声明的具体 UTI（png/tiff/jpeg/heic/mp4/pdf/file-url…），不靠类型名硬编码。
    private static let nonTextContentTypes: [UTType] = [.image, .movie, .audio, .pdf, .fileURL]

    /// 非标准 UTI 的历史兜底（UTType 无法归类）。
    private static let legacyNonTextTypes: Set<String> = [
        "NSFilenamesPboardType", // 旧版 Finder 文件列表
        "com.apple.finder.node",
        "NSRTFDPboardType", // 带附件富文本
        "com.apple.flat-rtfd",
    ]

    /// 上限只用于「整体拒绝」，绝不截断用户原文；与划选翻译 4000 字口径同量级。
    private static let maxCharacters = 8000

    struct Snapshot {
        let text: String
        let changeCount: Int
    }

    /// 通过全部校验才返回快照，否则 nil（调用方保持上一次内容）。
    static func plainTextSnapshot(from pasteboard: NSPasteboard) -> Snapshot? {
        guard let first = pasteboard.pasteboardItems?.first,
            // 在首项声明的所有类型里找纯文本，不看顺序。
            let plainType = first.types.first(where: { plainTextTypes.contains($0.rawValue) }),
            let raw = first.string(forType: plainType)
        else { return nil }

        // 图片 / 文件 / 音视频 / PDF 为主：纯文本只是兜底，不读。
        let isObjectCopy = first.types.contains { type in
            if legacyNonTextTypes.contains(type.rawValue) { return true }
            guard let ut = UTType(type.rawValue) else { return false }
            return nonTextContentTypes.contains { ut.conforms(to: $0) }
        }
        guard !isObjectCopy else { return nil }

        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isOrdinaryText(text) else { return nil }
        return Snapshot(text: text, changeCount: pasteboard.changeCount)
    }

    /// 内容是否像「普通文字」。这是一组准入校验，不是文本抽取或正则改写。
    static func isOrdinaryText(_ text: String) -> Bool {
        guard !text.isEmpty, text.count <= maxCharacters else { return false }

        // 至少一个字母（含 CJK 表意文字）：纯数字 / 标点 / emoji 不是待译正文。
        guard text.unicodeScalars.contains(where: { CharacterSet.letters.contains($0) }) else {
            return false
        }

        // 二进制残留：除 \t \n \r 之外的 C0/C1 控制字符、替换字符、BOM。
        for scalar in text.unicodeScalars {
            let value = scalar.value
            if value == 0x09 || value == 0x0A || value == 0x0D { continue }
            if value < 0x20 || (value >= 0x7F && value < 0xA0) || value == 0xFFFD || value == 0xFEFF {
                return false
            }
        }

        let hasWhitespace = text.unicodeScalars.contains {
            CharacterSet.whitespacesAndNewlines.contains($0)
        }
        let lower = text.lowercased()

        // 单个链接 / 文件路径 / data URI 属于「复制对象」而非普通文字；
        // 含空白的整段文字里带链接不受影响。
        if !hasWhitespace {
            if lower.hasPrefix("http://") || lower.hasPrefix("https://")
                || lower.hasPrefix("file://") || lower.hasPrefix("data:")
            {
                return false
            }
            // 长串无空白 ASCII（base64 / 哈希 / 序列化数据）不是正文；中文长段落不受影响。
            if text.count > 300 && text.unicodeScalars.allSatisfy({ $0.value < 128 }) {
                return false
            }
        }
        return true
    }
}
