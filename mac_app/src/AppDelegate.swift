import Cocoa
import WebKit

class AppState {
    static let processPool = WKProcessPool()
}

class AppDelegate: NSObject, NSApplicationDelegate {
    private var mainWindowController: MainWindowController!
    private var spotlightController: SpotlightPanelController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)

        // Setup Main Menu
        setupMainMenu()

        // Initialize Window Controllers
        mainWindowController = MainWindowController()
        spotlightController = SpotlightPanelController()

        spotlightController.onOpenMainWindow = { [weak self] in
            // Focus and trigger in-memory session sync without reloading the whole web page
            self?.mainWindowController.showAndFocus()
        }

        // Start Proxy if needed and show Main Window
        ProcessManager.shared.startProxyIfNeeded { [weak self] success in
            DispatchQueue.main.async {
                self?.mainWindowController.loadContent()
                self?.mainWindowController.showAndFocus()
                self?.spotlightController.loadContent()
            }
        }

        // Register Global HotKey (Option + Space)
        HotKeyManager.shared.onTrigger = { [weak self] in
            self?.spotlightController.toggle()
        }
        HotKeyManager.shared.register()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            mainWindowController.showAndFocus()
        }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        HotKeyManager.shared.unregister()
        ProcessManager.shared.stop()
    }

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        // 1. Application Menu
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 TurboFieldfare Chat", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "隐藏 TurboFieldfare Chat", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(withTitle: "显示全部", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出 TurboFieldfare Chat", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // 2. Edit Menu (Crucial for Cmd+C, Cmd+V, Cmd+A, Cmd+Z in WKWebView!)
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redoItem = NSMenuItem(title: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redoItem.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redoItem)
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        // 3. View Menu
        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "视图")
        let reloadItem = NSMenuItem(title: "重新载入", action: #selector(reloadActiveWindow), keyEquivalent: "r")
        viewMenu.addItem(reloadItem)
        let toggleSpotlightItem = NSMenuItem(title: "快捷悬浮窗", action: #selector(toggleSpotlightWindow), keyEquivalent: " ")
        toggleSpotlightItem.keyEquivalentModifierMask = [.option]
        viewMenu.addItem(toggleSpotlightItem)
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        // 4. Window Menu
        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)

        NSApp.mainMenu = mainMenu
    }

    @objc private func reloadActiveWindow() {
        mainWindowController?.reload()
    }

    @objc private func toggleSpotlightWindow() {
        spotlightController?.toggle()
    }
}
