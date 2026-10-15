import Cocoa
import WebKit

enum AppLocale {
    static var explicitLang: String? = nil

    static var isZh: Bool {
        if let explicit = explicitLang {
            return explicit.hasPrefix("zh")
        }
        return Locale.preferredLanguages.first?.hasPrefix("zh") ?? false
    }

    static func update(lang: String?) {
        if let l = lang, !l.isEmpty, l != "system" {
            explicitLang = l
        } else {
            explicitLang = nil
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    private var mainWindowController: MainWindowController!
    private var spotlightController: SpotlightPanelController!
    var statusBarController: StatusBarController!
    private var voiceOverlayController: VoiceOverlayPanelController!
    private var subtitleOverlayController: SubtitleOverlayPanelController!
    private var translationPanelController: TranslationPanelController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)

        // Setup Main Menu
        setupMainMenu()

        // Initialize Window Controllers
        mainWindowController = MainWindowController()
        spotlightController = SpotlightPanelController()
        voiceOverlayController = VoiceOverlayPanelController()
        subtitleOverlayController = SubtitleOverlayPanelController()
        translationPanelController = TranslationPanelController()

        spotlightController.onOpenMainWindow = { [weak self] in
            // Focus and trigger in-memory session sync without reloading the whole web page
            self?.mainWindowController.showAndFocus()
        }

        mainWindowController.onShrinkToSpotlight = { [weak self] sessionId, isExpanded in
            self?.spotlightController.showWithSession(sessionId: sessionId, isExpanded: isExpanded)
        }

        // Start Proxy if needed and show Main Window
        // 注意：字幕窗口（subtitleOverlayController）严格按需加载，启动时不预加载 WebView 或后台模型
        ProcessManager.shared.startProxyIfNeeded { [weak self] _ in
            DispatchQueue.main.async {
                self?.mainWindowController.loadContent()
                self?.mainWindowController.showAndFocus()
                self?.spotlightController.loadContent()
                self?.voiceOverlayController.loadContent()
            }
        }

        // Register Global HotKeys (Option + Space for Spotlight, Control + Space for Translator)
        HotKeyManager.shared.onTrigger = { [weak self] in
            self?.spotlightController.toggle()
        }
        HotKeyManager.shared.onTranslatorTrigger = { [weak self] in
            self?.translationPanelController.toggle()
        }
        HotKeyManager.shared.register()

        // 全局语音输入：长按右侧 Command 键 → 语音转文字
        // 状态实时驱动屏幕底部居中的悬浮胶囊 UI
        VoiceInputManager.shared.onStateChange = { [weak self] state, level, text, action in
            self?.voiceOverlayController.update(state: state, level: level, text: text, action: action)
        }
        VoiceInputManager.shared.install()

        // Menu bar status icon (single icon, left & right click open the same menu)
        statusBarController = StatusBarController()
        statusBarController.onOpenMainWindow = { [weak self] in
            self?.mainWindowController.showAndFocus()
        }
        statusBarController.onOpenSpotlight = { [weak self] in
            self?.spotlightController.show()
        }
        statusBarController.onOpenTranslator = { [weak self] in
            self?.translationPanelController.toggle()
        }
        statusBarController.onToggleSubtitles = { [weak self] in
            self?.subtitleOverlayController.toggle()
        }
        subtitleOverlayController.onVisibilityChanged = { [weak self] visible in
            self?.statusBarController?.updateSubtitleActiveState(visible)
        }
        statusBarController.setup()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            mainWindowController.showAndFocus()
        }
        return true
    }

    // MARK: - 退出：先停服务，再退出

    private var isTerminating = false
    private var didReplyToTermination = false
    private var didTeardownUI = false

    /// Dock 右键退出 / Cmd+Q / 状态栏菜单三条路径都汇到这里。
    ///
    /// 用 `applicationShouldTerminate` + `.terminateLater`，而不是在 `applicationWillTerminate`
    /// 里发个信号就走：这样「App 图标消失」时，代理与全部受管服务（含字幕模型进程）已经确认全部停止，
    /// 不会留下「App 没了但服务还在跑」的窗口。
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if isTerminating { return .terminateLater }
        isTerminating = true

        // 若字幕窗口正开着，先停止内录并关闭窗口
        subtitleOverlayController?.hide()

        ProcessManager.shared.stopAllServices { [weak self] in
            self?.teardownUI()
            self?.replyTermination()
        }

        // 安全阀：清理异常卡住时也不能让 App 退不掉（用户可能在注销 / 关机）
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            self?.teardownUI()
            self?.replyTermination()
        }

        return .terminateLater
    }

    private func replyTermination() {
        guard !didReplyToTermination else { return }
        didReplyToTermination = true
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    private func teardownUI() {
        guard !didTeardownUI else { return }
        didTeardownUI = true
        translationPanelController?.hide()
        subtitleOverlayController?.hide()
        statusBarController?.teardown()
        HotKeyManager.shared.unregister()
        VoiceInputManager.shared.uninstall()
    }

    func applicationWillTerminate(_ notification: Notification) {
        teardownUI()
        ProcessManager.shared.stop()
    }

    func setupMainMenu() {
        let isZh = AppLocale.isZh
        let mainMenu = NSMenu()

        // 1. Application Menu
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: isZh ? "关于 SimpleUI" : "About SimpleUI", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: isZh ? "隐藏 SimpleUI" : "Hide SimpleUI", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: isZh ? "隐藏其他" : "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(withTitle: isZh ? "显示全部" : "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: isZh ? "退出 SimpleUI" : "Quit SimpleUI", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // 2. Edit Menu (Crucial for Cmd+C, Cmd+V, Cmd+A, Cmd+Z in WKWebView!)
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: isZh ? "编辑" : "Edit")
        editMenu.addItem(withTitle: isZh ? "撤销" : "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redoItem = NSMenuItem(title: isZh ? "重做" : "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redoItem.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redoItem)
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: isZh ? "剪切" : "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: isZh ? "复制" : "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: isZh ? "粘贴" : "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: isZh ? "全选" : "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        // 3. View Menu（实时双语字幕仅在状态栏菜单中开启，不在此处重复放置）
        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: isZh ? "视图" : "View")
        let reloadItem = NSMenuItem(title: isZh ? "重新载入" : "Reload", action: #selector(reloadActiveWindow), keyEquivalent: "r")
        viewMenu.addItem(reloadItem)
        let toggleSpotlightItem = NSMenuItem(title: isZh ? "快捷悬浮窗" : "Mini Window", action: #selector(toggleSpotlightWindow), keyEquivalent: " ")
        toggleSpotlightItem.keyEquivalentModifierMask = [.option]
        viewMenu.addItem(toggleSpotlightItem)
        let toggleTranslatorItem = NSMenuItem(title: isZh ? "快捷翻译" : "Quick Translate", action: #selector(toggleTranslatorWindow), keyEquivalent: " ")
        toggleTranslatorItem.keyEquivalentModifierMask = [.control]
        viewMenu.addItem(toggleTranslatorItem)
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        // 4. Window Menu
        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: isZh ? "窗口" : "Window")
        windowMenu.addItem(withTitle: isZh ? "最小化" : "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: isZh ? "关闭窗口" : "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)

        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = windowMenu
    }

    @objc private func reloadActiveWindow() {
        mainWindowController?.reload()
    }

    @objc private func toggleSpotlightWindow() {
        spotlightController?.toggle()
    }

    @objc private func toggleTranslatorWindow() {
        translationPanelController?.toggle()
    }
}
