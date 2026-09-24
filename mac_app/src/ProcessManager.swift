import Foundation

class ProcessManager {
    static let shared = ProcessManager()
    static let serverPort = 31235
    static let baseURLString = "http://127.0.0.1:\(serverPort)"
    static let spotlightURLString = "http://127.0.0.1:\(serverPort)/#/spotlight"
    private var process: Process?
    private var port: Int { ProcessManager.serverPort }
    private(set) var isRunning = false

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

    private func checkServerReady(completion: @escaping (Bool) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else {
            completion(false)
            return
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 1.0

        let task = URLSession.shared.dataTask(with: request) { _, response, error in
            if error == nil, let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                DispatchQueue.main.async { completion(true) }
            } else {
                DispatchQueue.main.async { completion(false) }
            }
        }
        task.resume()
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

    func stop() {
        if let proc = process, proc.isRunning {
            proc.terminate()
            process = nil
        }
    }
}
