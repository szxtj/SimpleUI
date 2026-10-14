import Foundation

class ProcessManager {
    static let shared = ProcessManager()
    static let serverPort = 31235
    static let baseURLString = "http://127.0.0.1:\(serverPort)"
    static let spotlightURLString = "http://127.0.0.1:\(serverPort)/#/spotlight"
    private var process: Process?
    private var port: Int { ProcessManager.serverPort }
    private(set) var isRunning = false

    /// 退出清理的总预算；超时后不再等待（会尝试硬杀自己拉起的代理与所有受管子进程）
    private let shutdownTimeout: TimeInterval = 8.0
    /// 代理退出后，detached 兜底 watchdog 最多再活一个轮询周期（0.5s），留 1s 余量
    private let watchdogGrace: TimeInterval = 1.0

    /// 全部受管服务的 PID 文件清单（基础模型 / 语音识别 / 实时双语字幕）
    private let managedPidFiles: [String] = [
        "/tmp/turbo_fieldfare_server.pid",
        "/tmp/mference_server.pid",
        "/tmp/simpleui_audiocpp.pid",
        "/tmp/simpleui_subtitle_asr.pid",
        "/tmp/simpleui_subtitle_trans.pid"
    ]

    /// 启动入口：先检测并彻底清理任何上次残留的旧代理、旧模型与孤儿进程，再拉起全新服务，杜绝模块版本不一致
    func startProxyIfNeeded(completion: @escaping (Bool) -> Void) {
        cleanStaleProcessesBeforeLaunch { [weak self] in
            guard let self = self else {
                completion(false)
                return
            }
            self.launchNodeProxy { success in
                self.isRunning = success
                completion(success)
            }
        }
    }

    // MARK: - 启动前残留检测与全量清理

    /// 启动 App 时自动检测是否存在上次残留的旧代理或模型子进程，先完全清理再重新开启
    private func cleanStaleProcessesBeforeLaunch(completion: @escaping () -> Void) {
        pingProxy(timeout: 0.6) { [weak self] alive in
            guard let self = self else {
                completion()
                return
            }
            if alive {
                NSLog("[ProcessManager] 🧹 检测到端口 \(self.port) 存在旧版残留代理进程，正在请求退出并清理...")
                self.requestRemoteQuit()
                self.waitUntilProxyGoneForRelaunch(deadline: Date().addingTimeInterval(3.0)) {
                    self.forceSweepResidualProcesses()
                    completion()
                }
            } else {
                self.forceSweepResidualProcesses()
                completion()
            }
        }
    }

    private func waitUntilProxyGoneForRelaunch(deadline: Date, completion: @escaping () -> Void) {
        pingProxy(timeout: 0.3) { [weak self] alive in
            guard let self = self else {
                completion()
                return
            }
            if !alive || Date() >= deadline {
                completion()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    self.waitUntilProxyGoneForRelaunch(deadline: deadline, completion: completion)
                }
            }
        }
    }

    /// 精确清理所有受管 PID 文件对应的残留进程及孤儿模型服务（含字幕 ASR 与 1249 翻译服务）
    private func forceSweepResidualProcesses() {
        // 1. 按 PID 文件优雅 SIGTERM -> 强制 SIGKILL
        var killedPids: [pid_t] = []
        for pidFile in managedPidFiles {
            if let raw = try? String(contentsOfFile: pidFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
               let pidVal = Int32(raw), pidVal > 1 {
                if kill(pidVal, 0) == 0 {
                    kill(pidVal, SIGTERM)
                    killedPids.append(pidVal)
                }
            }
            try? FileManager.default.removeItem(atPath: pidFile)
        }

        if !killedPids.isEmpty {
            usleep(150_000) // 150ms 等待优雅退出
            for pidVal in killedPids where kill(pidVal, 0) == 0 {
                kill(pidVal, SIGKILL)
            }
        }

        // 2. 精确清扫可能未写入 PID 文件的同名孤儿进程（及占用 31235 / 1249 端口的旧实例）
        let cleanupScript = """
        pkill -x "subtitle_stream_asr" 2>/dev/null || true
        pkill -f "llama-server.*--port 1249" 2>/dev/null || true
        pkill -x "audiocpp_server" 2>/dev/null || true
        pkill -x "TurboFieldfareServer" 2>/dev/null || true
        pkill -x "MferenceServer" 2>/dev/null || true
        pkill -x "kiwix-serve" 2>/dev/null || true
        pkill -f "server/proxy.js" 2>/dev/null || true
        """
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = ["-c", cleanupScript]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try? task.run()
        task.waitUntilExit()
    }

    // MARK: - 代理身份探测

    /// 探测 31235 上是否跑着 SimpleUI 代理。
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

        let nvmDir = "\(home)/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmDir) {
            for ver in versions.sorted().reversed() {
                candidates.insert("\(nvmDir)/\(ver)/bin/node", at: 0)
            }
        }

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

    /// 退出前把代理与全部四个受管服务（知识库 / 基础模型 / 语音识别 / 实时字幕三级模型）全部停掉。
    func stopAllServices(completion: @escaping () -> Void) {
        pingProxy(timeout: 1.0) { [weak self] alive in
            guard let self = self else { completion(); return }
            guard alive else {
                // 即使代理已不在，也执行一次底层孤儿进程清扫，确保字幕或模型进程无一残留
                self.forceSweepResidualProcesses()
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
        // 代理退出后执行一次原生层兜底清扫，确保字幕模型与所有受管子进程 100% 终止
        forceSweepResidualProcesses()
        DispatchQueue.main.asyncAfter(deadline: .now() + watchdogGrace) { completion() }
    }

    /// 兜底：直接给代理进程发 SIGTERM 并清扫受管子进程
    func stop() {
        if let proc = process, proc.isRunning {
            proc.terminate()
            process = nil
        }
        forceSweepResidualProcesses()
    }
}
