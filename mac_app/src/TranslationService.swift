import Foundation

public protocol TranslationServiceProtocol: Sendable {
    func translate(text: String, mode: TranslationMode) async throws -> String
    func translate(text: String, mode: TranslationMode, baseLang: String) async throws -> String
}

extension TranslationServiceProtocol {
    public func translate(text: String, mode: TranslationMode) async throws -> String {
        let baseLang = UserDefaults.standard.string(forKey: "simpleui_translator_base_lang") ?? "zh"
        return try await translate(text: text, mode: mode, baseLang: baseLang)
    }
}

public enum TranslationServiceError: LocalizedError, Equatable {
    case invalidURL
    case invalidResponse
    case serverError(Int)
    case emptyResult
    case requestFailed(String)
    case timeout
    case cancelled

    public var errorDescription: String? {
        let isZh = AppLocale.isZh
        switch self {
        case .invalidURL:
            return isZh ? "翻译服务地址无效。" : "Invalid translation service URL."
        case .invalidResponse:
            return isZh ? "翻译服务返回了非预期的响应。" : "Unexpected response from translation service."
        case .serverError(let statusCode):
            return isZh ? "翻译服务返回 HTTP \(statusCode)。" : "Translation service returned HTTP \(statusCode)."
        case .emptyResult:
            return isZh ? "翻译服务返回了空内容。" : "Translation service returned empty content."
        case .requestFailed(let message):
            return isZh ? "翻译请求失败: \(message)" : "Translation request failed: \(message)"
        case .timeout:
            return isZh ? "连接翻译服务超时（3秒），已自动终止。" : "Connection to translation service timed out (3s)."
        case .cancelled:
            return isZh ? "已终止翻译。" : "Translation stopped."
        }
    }
}

public struct TranslationService: TranslationServiceProtocol {
    private let customEndpoint: URL?
    private let customModel: String?
    private let customTemperature: Double?
    public let session: URLSession

    public init(
        endpoint: URL? = nil,
        model: String? = nil,
        temperature: Double? = nil,
        session: URLSession = .shared
    ) {
        self.customEndpoint = endpoint
        self.customModel = model
        self.customTemperature = temperature
        self.session = session
    }

    public func translate(text: String, mode: TranslationMode) async throws -> String {
        let baseLang = UserDefaults.standard.string(forKey: "simpleui_translator_base_lang") ?? "zh"
        return try await translate(text: text, mode: mode, baseLang: baseLang)
    }

    public func translate(text: String, mode: TranslationMode, baseLang: String) async throws -> String {
        let defaults = UserDefaults.standard
        let apiBase = defaults.string(forKey: "simpleui_translator_api_endpoint") ?? "http://127.0.0.1:1235/v1"
        let model = customModel ?? defaults.string(forKey: "simpleui_translator_model") ?? "gemma-4-26b-a4b-it"
        let temperature = customTemperature ?? (defaults.object(forKey: "simpleui_translator_temperature") as? Double ?? 1.0)

        let endpointURL: URL
        if let customEndpoint = customEndpoint {
            endpointURL = customEndpoint
        } else {
            let cleanBase = apiBase.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if cleanBase.hasSuffix("/responses") || cleanBase.hasSuffix("/chat/completions") {
                guard let url = URL(string: cleanBase) else {
                    throw TranslationServiceError.invalidURL
                }
                endpointURL = url
            } else {
                guard let url = URL(string: "\(cleanBase)/chat/completions") else {
                    throw TranslationServiceError.invalidURL
                }
                endpointURL = url
            }
        }

        var request = URLRequest(url: endpointURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let apiKey = defaults.string(forKey: "simpleui_translator_api_key"),
            !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }

        var body: [String: Any] = [
            "model": model,
            "temperature": temperature,
        ]

        let provider = defaults.string(forKey: "simpleui_translator_api_provider") ?? "ttf"
        let reasoningEffort = defaults.string(forKey: "simpleui_translator_reasoning_effort") ?? "none"

        if reasoningEffort == "none" || reasoningEffort.isEmpty {
            body["reasoning_effort"] = "none"
            body["chat_template_kwargs"] = ["enable_thinking": false]
            body["thinking"] = ["type": "disabled"]
        } else {
            body["chat_template_kwargs"] = ["enable_thinking": true]
            if provider == "mference" {
                body["reasoning_effort"] = (reasoningEffort == "high" || reasoningEffort == "max") ? "xhigh" : reasoningEffort
            } else if provider == "ttf" {
                body["reasoning_effort"] = "default"
            } else {
                body["reasoning_effort"] = reasoningEffort
            }
            body["thinking"] = ["type": "enabled"]
        }

        if endpointURL.path.contains("responses") {
            body["input"] = Self.makePrompt(for: text, mode: mode, baseLang: baseLang)
        } else {
            let systemPrompt = Self.makeSystemInstruction(for: mode, text: text, baseLang: baseLang)
            body["messages"] = [
                ["role": "system", "content": systemPrompt],
                ["role": "user", "content": text],
            ]
        }

        request.timeoutInterval = 3.0
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let session = self.session
        let timeoutDuration: UInt64 = 3_000_000_000 // 3秒超时

        do {
            let translation = try await withThrowingTaskGroup(of: String.self) { group in
                // 任务1：发起网络翻译请求
                group.addTask {
                    let (data, response) = try await session.data(for: request)
                    try Task.checkCancellation()

                    guard let httpResponse = response as? HTTPURLResponse else {
                        throw TranslationServiceError.invalidResponse
                    }

                    guard (200..<300).contains(httpResponse.statusCode) else {
                        throw TranslationServiceError.serverError(httpResponse.statusCode)
                    }

                    return try Self.extractTranslation(from: data)
                }

                // 任务2：3秒硬超时监视器
                group.addTask {
                    try await Task.sleep(nanoseconds: timeoutDuration)
                    throw TranslationServiceError.timeout
                }

                // 获取最先完成的任务结果
                guard let result = try await group.next() else {
                    throw TranslationServiceError.emptyResult
                }
                group.cancelAll()
                return result
            }
            return translation
        } catch is CancellationError {
            throw TranslationServiceError.cancelled
        } catch let error as TranslationServiceError {
            throw error
        } catch {
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut {
                throw TranslationServiceError.timeout
            }
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
                throw TranslationServiceError.cancelled
            }
            throw TranslationServiceError.requestFailed(error.localizedDescription)
        }
    }

    public func fetchLoadedModels(baseURL: String, apiKey: String? = nil) async throws -> [String] {
        let cleanBase = baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(cleanBase)/models") else {
            throw TranslationServiceError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        let defaults = UserDefaults.standard
        let effectiveKey = apiKey ?? defaults.string(forKey: "simpleui_translator_api_key")
        if let effectiveKey = effectiveKey,
            !effectiveKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            request.setValue("Bearer \(effectiveKey)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
            (200..<300).contains(httpResponse.statusCode)
        else {
            throw TranslationServiceError.invalidResponse
        }

        struct ModelListResponse: Decodable {
            struct ModelItem: Decodable {
                let id: String
            }
            let data: [ModelItem]
        }

        let decoder = JSONDecoder()
        let result = try decoder.decode(ModelListResponse.self, from: data)
        return result.data.map { $0.id }
    }

    public static func makePrompt(for text: String, mode: TranslationMode, baseLang: String = "zh") -> String {
        let instruction = makeSystemInstruction(for: mode, text: text, baseLang: baseLang)
        return "\(instruction)\n\n\(text)"
    }

    public static func makeSystemInstruction(for mode: TranslationMode, text: String, baseLang: String = "zh") -> String {
        let hasChinese = containsChinese(text)
        let isZhBase = (baseLang != "en")

        switch mode {
        case .quick:
            if isZhBase {
                if hasChinese {
                    // 情况 1-1：中文基准 · 中译英快速 (明确美式日常英语)
                    return "Translate into natural, everyday American English. Output the translation only."
                } else {
                    // 情况 1-2：中文基准 · 英译中快速
                    return "翻译为自然流畅的简体中文。仅输出翻译结果。"
                }
            } else {
                if hasChinese {
                    // 情况 2-1：英文基准 · 中译英快速
                    return "Translate into natural English. Output the translation only."
                } else {
                    // 情况 2-2：英文基准 · 英译中快速
                    return "Translate into natural Simplified Chinese. Output the translation only."
                }
            }

        case .detail:
            if isZhBase {
                if hasChinese {
                    // 情况 1-3：中文基准 · 中译英详解 (优先美式日常表达，展示全面，英式加【英】)
                    return """
                        请将输入的中文解析为地道英文表达，Markdown 格式：
                        1. 表达推荐：优先美式日常表达，尽量展示全面不同表达；英式特有表达前标注【英】。
                        2. 简要辨析：注明词性、语境及正式程度差异。
                        3. 双语例句：为主要表达提供 1-2 个实用英文例句及中文对照。
                        注意：不输出音标，不输出寒暄或多余前言。
                        """
                } else {
                    // 情况 1-4：中文基准 · 英译中详解
                    return """
                        请解析输入的英文单词或短语，Markdown 格式：
                        1. 词性及准确中文释义（分点列出）。
                        2. 2 个实用的英文例句及中文对照翻译。
                        注意：不输出音标，不输出寒暄或多余前言。
                        """
                }
            } else {
                if hasChinese {
                    // 情况 2-3：英文基准 · 中文输入详解 (向英文用户解释中文)
                    return """
                        Analyze the Chinese input for English speakers in Markdown:
                        1. Pinyin with tone marks and part of speech.
                        2. Clear English definitions.
                        3. Usage and context notes.
                        4. 2 authentic example sentences (Chinese, Pinyin, English).
                        Output only the analysis without conversational filler.
                        """
                } else {
                    // 情况 2-4：英文基准 · 英文输入详解 (向英文用户提供地道中文表达)
                    return """
                        Provide authentic Chinese equivalents for English speakers in Markdown:
                        1. Chinese expressions with Pinyin.
                        2. Nuance and register differences in English.
                        3. 1-2 bilingual example sentences.
                        Output only the analysis without conversational filler.
                        """
                }
            }
        }
    }

    private static func containsChinese(_ text: String) -> Bool {
        return text.unicodeScalars.contains { scalar in
            let value = scalar.value
            return (value >= 0x4E00 && value <= 0x9FFF) || (value >= 0x3400 && value <= 0x4DBF)
                || (value >= 0x20000 && value <= 0x2A6DF) || (value >= 0xF900 && value <= 0xFAFF)
        }
    }

    public static func stripThinkingProcess(_ text: String) -> String {
        var clean = text
        let patterns = [
            "(?i)<think>[\\s\\S]*?</think>",
            "(?i)<thought>[\\s\\S]*?</thought>",
        ]
        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: []) {
                let range = NSRange(location: 0, length: clean.utf16.count)
                clean = regex.stringByReplacingMatches(
                    in: clean, options: [], range: range, withTemplate: "")
            }
        }
        let unclosedTags = ["<think>", "<thought>"]
        for tag in unclosedTags {
            if let range = clean.range(of: tag, options: .caseInsensitive) {
                clean = String(clean[..<range.lowerBound])
            }
        }
        return clean.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func extractTranslation(from data: Data) throws -> String {
        let object = try JSONSerialization.jsonObject(with: data)
        guard let json = object as? [String: Any] else {
            throw TranslationServiceError.invalidResponse
        }

        var textResult = ""

        if let outputText = json["output_text"] as? String {
            textResult = outputText
        } else if let output = json["output"] as? [[String: Any]] {
            if let messageItem = output.first(where: { ($0["type"] as? String) == "message" }),
                let contentArray = messageItem["content"] as? [[String: Any]],
                let text = contentArray.compactMap({ $0["text"] as? String }).first(where: {
                    !$0.isEmpty
                })
            {
                textResult = text
            } else if let content =
                output
                .compactMap({ $0["content"] as? [[String: Any]] })
                .flatMap({ $0 })
                .compactMap({ $0["text"] as? String })
                .first(where: { !$0.isEmpty })
            {
                textResult = content
            }
        } else if let choices = json["choices"] as? [[String: Any]],
            let firstChoice = choices.first,
            let message = firstChoice["message"] as? [String: Any],
            let content = message["content"] as? String
        {
            textResult = content
        } else {
            throw TranslationServiceError.emptyResult
        }

        let trimmed = textResult.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return stripThinkingProcess(trimmed)
        }

        throw TranslationServiceError.emptyResult
    }
}
