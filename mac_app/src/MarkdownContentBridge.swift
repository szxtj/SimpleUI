import Cocoa
import UniformTypeIdentifiers
import WebKit

/// Markdown 渲染内容所依赖的**原生能力桥**，三个窗口共用这一份实现：
///   - 主窗口对话区（`MainWindowController`）
///   - 快捷浮窗（`SpotlightPanelController`）
///   - Markdown 编辑器窗口（`MarkdownEditorPanelController`）
///
/// 背景：三个窗口渲染的都是同一个 `<MarkdownRenderer>`（代码块 / 表格 / 公式工具条 /
/// 划选浮标 / 图片放大），其中若干动作必须落到原生；**少注册一个名字，前端就会静默降级**：
///
/// | 名字 | 前端入口 | 缺失时的表现 |
/// |---|---|---|
/// | copyRichData       | 表格「复制表格」、公式「复制 LaTeX 原文」 | 退回浏览器 ClipboardItem，Word/Excel 里粘不出富文本 |
/// | copyWordEquation   | 公式「复制公式块」            | 退回 writeText，Word 里粘不出原生公式 |
/// | openTableInWord    | 表格「在 Word 中打开」        | 点了完全没反应 |
/// | openImageInPreview | 图片放大后的「在预览中打开」   | 点了没反应 |
/// | saveImage          | 图片放大后的「存储」          | 点了没反应 |
/// | translateSelection | 划选浮标的「翻译」            | **按钮直接不显示**（浮标只剩朗读/复制） |
/// | openHtmlInBrowser  | HTML 代码块预览的「在浏览器打开」 | 点了没反应 |
/// | saveHtmlFile       | HTML 代码块预览的「下载 HTML」   | 点了没反应 |
///
/// 这三个窗口原先各写了一份逐字相同的 switch（主窗口 + 浮窗两份，编辑器窗口漏了），
/// 这里合并成一份，注册用 `messageNames`，注册方法见 `attach(to:hostWindow:)`。
final class MarkdownContentBridge: NSObject, WKScriptMessageHandler {
    static let messageNames: [String] = [
        "copyRichData",
        "copyWordEquation",
        "openTableInWord",
        "openImageInPreview",
        "saveImage",
        "translateSelection",
        "openHtmlInBrowser",
        "saveHtmlFile",
    ]

    /// 保存图片时用作 sheet 宿主。浮窗传 nil —— 它本来就是浮动面板，
    /// 挂 sheet 会多出一层无谓的动画，保持原来的独立面板行为。
    private weak var hostWindow: NSWindow?

    init(hostWindow: NSWindow?) {
        self.hostWindow = hostWindow
        super.init()
    }

    /// 把这套能力注册到某个 WebView 的 user content controller 上。
    /// 返回 bridge 实例本身，调用方需要强引用它（WKUserContentController 也会持有）。
    @discardableResult
    static func attach(to userContent: WKUserContentController, hostWindow: NSWindow?) -> MarkdownContentBridge {
        let bridge = MarkdownContentBridge(hostWindow: hostWindow)
        for name in messageNames {
            userContent.add(bridge, name: name)
        }
        return bridge
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard Self.messageNames.contains(message.name) else { return }
        let dict = message.body as? [String: Any] ?? [:]

        switch message.name {
        case "copyRichData":
            let html = dict["html"] as? String ?? ""
            let plainText = dict["plainText"] as? String ?? ""
            DispatchQueue.main.async {
                let pb = NSPasteboard.general
                pb.clearContents()
                if !html.isEmpty {
                    pb.setString(html, forType: .html)
                }
                if !plainText.isEmpty {
                    pb.setString(plainText, forType: .string)
                }
            }

        case "copyWordEquation":
            let mathml = dict["mathml"] as? String ?? ""
            DispatchQueue.main.async {
                let pb = NSPasteboard.general
                pb.clearContents()
                // Claude 黄金法则：只写唯一的纯文本 MathML，绝不放任何 HTML/RTF，
                // 让 Word 的内容嗅探直接命中公式转换！
                pb.setString(mathml, forType: .string)
            }

        case "openTableInWord":
            guard let docXml = dict["documentXml"] as? String else { return }
            DispatchQueue.global(qos: .userInitiated).async {
                MainWindowController.createAndOpenDocx(documentXml: docXml)
            }

        case "openImageInPreview":
            guard let urlString = dict["url"] as? String else { return }
            DispatchQueue.global(qos: .userInitiated).async {
                MainWindowController.openImageInSystemPreview(urlString: urlString)
            }

        case "saveImage":
            guard let urlString = dict["url"] as? String else { return }
            DispatchQueue.main.async { [weak self] in
                self?.showSaveImagePanel(urlString: urlString)
            }

        case "openHtmlInBrowser":
            let html = dict["html"] as? String ?? ""
            let filename = dict["filename"] as? String ?? ""
            guard !html.isEmpty else { return }
            DispatchQueue.main.async { [weak self] in
                self?.openHtmlInBrowser(html: html, filename: filename)
            }

        case "saveHtmlFile":
            let html = dict["html"] as? String ?? ""
            let filename = dict["filename"] as? String ?? ""
            guard !html.isEmpty else { return }
            DispatchQueue.main.async { [weak self] in
                self?.showSaveHtmlPanel(html: html, filename: filename)
            }

        case "translateSelection":
            // 划选浮标的「翻译」：交给原生快捷翻译窗口（自动翻译）
            let text = dict["text"] as? String ?? ""
            let trimmed = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(4000))
            guard !trimmed.isEmpty else { return }
            DispatchQueue.main.async {
                (NSApp.delegate as? AppDelegate)?.translationPanelController?.present(
                    text: trimmed, mode: .quick, autoTranslate: true)
            }

        default:
            break
        }
    }

    /// 弹出原生保存对话框，把图片（媒体库文件 / data URL / 远程 URL）写到用户指定位置
    private func showSaveImagePanel(urlString: String) {
        let savePanel = NSSavePanel()
        let isZh = AppLocale.isZh
        savePanel.title = isZh ? "保存图片" : "Save Image"
        savePanel.prompt = isZh ? "保存" : "Save"
        savePanel.canCreateDirectories = true

        let timestamp = Int(Date().timeIntervalSince1970)
        var defaultExt = "png"
        var imageData: Data? = nil

        if urlString.contains("/api/media/") {
            let filename = urlString.components(separatedBy: "/api/media/").last?
                .components(separatedBy: "?").first?
                .components(separatedBy: "#").first ?? ""
            if !filename.isEmpty {
                let home = FileManager.default.homeDirectoryForCurrentUser
                let mediaFile = home.appendingPathComponent("Library/Application Support/SimpleUI/media", isDirectory: true)
                    .appendingPathComponent(filename)
                let ext = mediaFile.pathExtension
                if !ext.isEmpty { defaultExt = ext }
                imageData = try? Data(contentsOf: mediaFile)
            }
        } else if urlString.hasPrefix("data:image/") {
            let parts = urlString.components(separatedBy: ",")
            if parts.count >= 2 {
                let header = parts[0].lowercased()
                if header.contains("jpeg") || header.contains("jpg") {
                    defaultExt = "jpg"
                } else if header.contains("webp") {
                    defaultExt = "webp"
                } else if header.contains("gif") {
                    defaultExt = "gif"
                }
                imageData = Data(base64Encoded: parts[1], options: .ignoreUnknownCharacters)
            }
        } else if let url = URL(string: urlString) {
            let ext = url.pathExtension
            if !ext.isEmpty { defaultExt = ext }
            imageData = try? Data(contentsOf: url)
        }

        savePanel.nameFieldStringValue = "SimpleUI_\(timestamp).\(defaultExt)"
        if let type = UTType(filenameExtension: defaultExt) {
            savePanel.allowedContentTypes = [type]
        }

        let handleResponse: (NSApplication.ModalResponse) -> Void = { response in
            if response == .OK, let destinationURL = savePanel.url, let data = imageData {
                try? data.write(to: destinationURL)
            }
        }

        if let win = hostWindow, win.attachedSheet == nil {
            savePanel.beginSheetModal(for: win, completionHandler: handleResponse)
        } else {
            savePanel.begin(completionHandler: handleResponse)
        }
    }

    // MARK: - HTML 代码块预览（在浏览器打开 / 下载）

    /// 预览临时目录：`~/Library/Caches/SimpleUI/html-preview/`
    /// 只放「在浏览器打开」用的临时文件；「下载」走 NSSavePanel，不落这里。
    private static func htmlPreviewDirectory() -> URL? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return nil
        }
        let dir = caches.appendingPathComponent("SimpleUI/html-preview", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            return nil
        }
        return dir
    }

    /// 只净化*文件名*：保留中文与常规字符，把路径分隔符等换成 `-`，主体截到 60 字符再补 `.html`。
    /// 绝不碰内容 —— 打开/下载出去的 HTML 与模型生成的原文逐字一致。
    private static func sanitizedHtmlName(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let illegal = CharacterSet(charactersIn: "/\\:*?\"<>|\n\r\t")
        var stem = trimmed.components(separatedBy: illegal).joined(separator: "-")
        if stem.lowercased().hasSuffix(".html") { stem = String(stem.dropLast(5)) }
        stem = stem.trimmingCharacters(in: CharacterSet(charactersIn: " .-"))
        if stem.count > 60 { stem = String(stem.prefix(60)) }
        return stem.isEmpty ? "" : stem + ".html"
    }

    private func openHtmlInBrowser(html: String, filename: String) {
        guard let dir = Self.htmlPreviewDirectory(),
              let data = html.data(using: .utf8) else { return }
        let stamp = Int(Date().timeIntervalSince1970)
        let safe = Self.sanitizedHtmlName(filename)
        let name = safe.isEmpty ? "preview-\(stamp).html" : "\(stamp)-\(safe)"
        let fileURL = dir.appendingPathComponent(name)
        do {
            try data.write(to: fileURL, options: .atomic)
        } catch {
            NSLog("[MarkdownContentBridge] 写入 HTML 预览文件失败: \(error)")
            return
        }
        Self.pruneHtmlPreviewDirectory(dir, keeping: fileURL)
        NSWorkspace.shared.open(fileURL)
    }

    /// 顺手清理 24 小时前的旧临时文件，避免每次「在浏览器打开」都留下一个永不回收的副本
    private static func pruneHtmlPreviewDirectory(_ dir: URL, keeping current: URL) {
        guard let items = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.contentModificationDateKey]
        ) else { return }
        let cutoff = Date().addingTimeInterval(-24 * 3600)
        for item in items where item != current {
            let modified = (try? item.resourceValues(forKeys: [.contentModificationDateKey])
                .contentModificationDate) ?? Date()
            if modified < cutoff {
                try? FileManager.default.removeItem(at: item)
            }
        }
    }

    private func showSaveHtmlPanel(html: String, filename: String) {
        let savePanel = NSSavePanel()
        let isZh = AppLocale.isZh
        savePanel.title = isZh ? "保存 HTML" : "Save HTML"
        savePanel.prompt = isZh ? "保存" : "Save"
        savePanel.canCreateDirectories = true
        savePanel.allowedContentTypes = [.html]

        let safe = Self.sanitizedHtmlName(filename)
        savePanel.nameFieldStringValue = safe.isEmpty
            ? "page-\(Int(Date().timeIntervalSince1970)).html"
            : safe

        let data = html.data(using: .utf8) ?? Data()
        let handleResponse: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .OK, let destinationURL = savePanel.url else { return }
            do {
                try data.write(to: destinationURL)
            } catch {
                NSLog("[MarkdownContentBridge] 保存 HTML 失败: \(error)")
            }
        }

        if let win = hostWindow, win.attachedSheet == nil {
            savePanel.beginSheetModal(for: win, completionHandler: handleResponse)
        } else {
            savePanel.begin(completionHandler: handleResponse)
        }
    }
}
