import Foundation

class ProcessManager {
    static let shared = ProcessManager()
    static let serverPort = 31235
    static let baseURLString = "http://127.0.0.1:\(serverPort)"
    static let spotlightURLString = "http://127.0.0.1:\(serverPort)/#/spotlight"
    private var process: Process?
    private var port: Int { ProcessManager.serverPort }
    private(set) var isRunning = false

    /// 退出清理的总预算；超时后不再等待（会尝试硬杀自己拉起的代理）
    private let shutdownTimeout: TimeInterval = 8.0
    /// 代理退出后，detached 兜底 watchdog 最多再活一个轮询周期（0.5s），留 1s 余量
    private let watchdogGrace: TimeInterval = 1.0

    func startProxyIfNeeded(completion: @escaping (Bool) -> Void) {
        checkServerReady { isReady in
            if isReady {
                print("Local proxy server is already running on port \(self.port)")
                self.isRunning = true
                completion(true)
                return
            }

            self.launchNodeProxy { success in
                self.isRunning = success
                completion(success)
            }
        }
    }

    // MARK: - 代理身份探测

    /// 探测 31235 上是否跑着 SimpleUI 代理。
    ///
    /// 用代理自己的 `/api/system/ping`，而不是 `/health`：后者会被代理转发给基础模型服务，
    /// 模型未就绪（加载中 / 开关关闭）时返回 502，会被误判成「代理没在跑」——于是重复拉起
    /// 一个注定 EADDRINUSE 的 node，而真正的代理反倒不在本 App 管理之下，退出时停不掉它。
    private func pingProxy(timeout: TimeInterval, completion: @escaping (Bool) -> Void) {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/api/system/ping") else {
            completion(false)
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData

        URLSession.shared.dataTask(with: request) { data, response, error in
            var alive = false
            if error == nil,
               let http = response as? HTTPURLResponse, http.statusCode == 200,
               let data = data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               (obj["app"] as? String) == "SimpleUI" {
                alive = true
            }
            DispatchQueue.main.async { completion(alive) }
        }.resume()
    }

    private func checkServerReady(completion: @escaping (Bool) -> Void) {
        pingProxy(timeout: 1.0, completion: completion)
    }

    private func launchNodeProxy(completion: @escaping (Bool) -> Void) {
        // Resolve project root directory
        let bundlePath = Bundle.main.bundlePath
        let resourcesDir = Bundle.main.resourcePath ?? "\(bundlePath)/Contents/Resources"
        let projectDir: String
        let scriptPath: String

        if FileManager.default.fileExists(atPath: "\(resourcesDir)/server/proxy.js") {
            // Self-contained bundled application
            projectDir = resourcesDir
            scriptPath = "\(resourcesDir)/server/proxy.js"
        } else {
            // If running from build/SimpleUI.app during dev, project root is ../..
            let potentialParent = (bundlePath as NSString).deletingLastPathComponent
            let potentialRoot = (potentialParent as NSString).deletingLastPathComponent
            if FileManager.default.fileExists(atPath: "\(potentialRoot)/server/proxy.js") {
                projectDir = potentialRoot
            } else {
                projectDir = FileManager.default.homeDirectoryForCurrentUser
                    .appendingPathComponent("Projects/SimpleUI").path
            }
            scriptPath = "\(projectDir)/server/proxy.js"
        }
        guard FileManager.default.fileExists(atPath: scriptPath) else {
            print("Cannot find proxy script at: \(scriptPath)")
            completion(false)
            return
        }

        // Find node executable
        let nodePath = findNodeExecutable()
        guard let node = nodePath else {
            print("Node.js executable not found in PATH")
            completion(false)
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments = [scriptPath]
        proc.currentDirectoryURL = URL(fileURLWithPath: projectDir)

        var env = ProcessInfo.processInfo.environment
        env["PORT"] = "\(port)"
        proc.environment = env

        do {
            try proc.run()
            self.process = proc

            // Wait for it to become ready
            var attempts = 0
            Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { timer in
                attempts += 1
                self.checkServerReady { isReady in
                    if isReady {
                        timer.invalidate()
                        completion(true)
                    } else if attempts > 20 {
                        timer.invalidate()
                        completion(false)
                    }
                }
            }
        } catch {
            print("Failed to start proxy process: \(error)")
            completion(false)
        }
    }

    private func findNodeExecutable() -> String? {
        // 优先使用随 App 打包的 Node 运行时（Contents/Resources/node/bin/node），
        // 完全私有于本 App、不依赖用户系统是否安装 Node、不影响整体环境。
        if let resourcesDir = Bundle.main.resourcePath {
            let bundled = "\(resourcesDir)/node/bin/node"
            if FileManager.default.isExecutableFile(atPath: bundled) {
                return bundled
            }
        }

        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var candidates: [String] = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ]

        // Dynamically discover all installed NVM Node versions
        let nvmDir = "\(home)/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmDir) {
            for ver in versions.sorted().reversed() {
                candidates.insert("\(nvmDir)/\(ver)/bin/node", at: 0)
            }
        }

        // Additional common Node version managers (fnm, volta, asdf)
        candidates.append("\(home)/.local/share/fnm/current/bin/node")
        candidates.append("\(home)/.volta/bin/node")
        candidates.append("\(home)/.asdf/shims/node")

        for path in candidates {
            if FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        }
        return nil
    }

    // MARK: - 退出清理

    /// 退出前把代理与三个受管服务全部停掉，完成后回调（主线程）。
    ///
    /// 两种情况都要覆盖，才谈得上「退出即全停」：
    ///  - 代理由本 App 拉起 → 直接 SIGTERM，走 proxy 的 cleanupAndExit 钩子；
    ///  - 代理已在运行（例如先在终端跑过 ./start.sh）→ 走 POST /api/system/quit 请它自己退出。
    /// 两条路径最终都汇到同一处：依次终止 kiwix / 基础模型 / 语音识别。
    /// 回调前会等到 31235 不再响应，并留出兜底 watchdog 自行退出的时间。
    func stopAllServices(completion: @escaping () -> Void) {
        pingProxy(timeout: 1.0) { [weak self] alive in
            guard let self = self else { completion(); return }
            guard alive else {
                // 代理本来就没在跑（或端口上不是 SimpleUI），无需清理
                self.process = nil
                self.isRunning = false
                completion()
                return
            }

            if let proc = self.process, proc.isRunning {
                proc.terminate()
            } else {
                self.requestRemoteQuit()
            }

            self.waitUntilProxyGone(deadline: Date().addingTimeInterval(self.shutdownTimeout),
                                    completion: completion)
        }
    }

    /// 请已在运行的代理自己退出（等价于 Ctrl+C，走同一套退出钩子）
    private func requestRemoteQuit() {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/api/system/quit") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 2.0
        // 故意不带 Origin 头：代理据此确认请求不是浏览器发起的（防 CSRF）
        URLSession.shared.dataTask(with: request) { _, _, _ in }.resume()
    }

    private func waitUntilProxyGone(deadline: Date, completion: @escaping () -> Void) {
        pingProxy(timeout: 0.4) { [weak self] alive in
            guard let self = self else { completion(); return }
            guard alive else {
                self.finishStop(completion)
                return
            }
            if Date() >= deadline {
                // 最后手段：确实是自己拉起的就直接 SIGKILL
                //（受管服务交给 detached watchdog 收拾）
                if let proc = self.process, proc.isRunning {
                    kill(proc.processIdentifier, SIGKILL)
                }
                self.finishStop(completion)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                    self.waitUntilProxyGone(deadline: deadline, completion: completion)
                }
            }
        }
    }

    private func finishStop(_ completion: @escaping () -> Void) {
        process = nil
        isRunning = false
        DispatchQueue.main.asyncAfter(deadline: .now() + watchdogGrace) { completion() }
    }

    /// 兜底：直接给代理进程发 SIGTERM（正常退出走 stopAllServices）
    func stop() {
        if let proc = process, proc.isRunning {
            proc.terminate()
            process = nil
        }
    }
}
