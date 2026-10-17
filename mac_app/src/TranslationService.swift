import Foundation

public protocol TranslationServiceProtocol: Sendable {
    func translate(text: String, mode: TranslationMode) async throws -> String
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
            body["input"] = Self.makePrompt(for: text, mode: mode)
        } else {
            let systemPrompt = Self.makeSystemInstruction(for: mode, text: text)
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

    public static func makePrompt(for text: String, mode: TranslationMode) -> String {
        switch mode {
        case .auto:
            return """
                Detect the language of the following text and translate it to the other language between Simplified Chinese and English.
                Return only the translation result.
                Do not explain anything.

                Text:
                \(text)
                """
        case .zhToEn:
            return """
                Translate the following Chinese text into natural English.
                Return only the translation result.
                Do not explain anything.

                Text:
                \(text)
                """
        case .enToZh:
            return """
                Translate the following English text into natural Simplified Chinese.
                Return only the translation result.
                Do not explain anything.

                Text:
                \(text)
                """
        case .detail:
            if containsChinese(text) {
                return """
                    你是一个多角度翻译与例句助手。请分析输入的中文内容：
                    1. 列出该中文对应的一至多个最常用、最可能的英文单词或短语（分点列出）。
                    2. 对于每一个候选英文单词或短语，提供：
                       - 词性 (Part of speech，若为单单词则提供)
                       - 语境释义 (简要说明在何种语境下使用该词/短语)
                       - 英文例句及对应的中文翻译 (提供至少一个高质量的双语对照例句)

                    注意约束：
                    - 绝对不要输出任何音标。
                    - 只输出 Markdown 格式的排版结果，不要包含任何前言介绍、解释性废话或代码块。

                    输入内容：
                    \(text)
                    """
            } else {
                return """
                    你是一个词汇解析助手。请分析输入的英文内容：
                    1. 判断输入是单个单词还是短语。如果是单个单词，请给出词性（如：n. / v. / adj.）；如果是短语或词组，请忽略并不要输出词性。
                    2. 以无序列表（分点）形式给出多个准确的中文释义。
                    3. 针对该单词或短语，提供 2-3 个生动实用的英文例句，并附带对应的中文翻译。

                    注意约束：
                    - 绝对不要输出任何音标。
                    - 只输出 Markdown 格式的排版结果，不要包含任何前言介绍、解释性废话或代码块。

                    输入内容：
                    \(text)
                    """
            }
        }
    }

    public static func makeSystemInstruction(for mode: TranslationMode, text: String) -> String {
        switch mode {
        case .auto:
            return "Detect the language of the text and translate it to the other language between Simplified Chinese and English. Output ONLY the clean translation result, with absolutely no explanation, reasoning process, formatting, introduction, or repeating."
        case .zhToEn:
            return "Translate the Chinese text into natural English. Output ONLY the clean translation result, with absolutely no explanation, reasoning process, formatting, introduction, or repeating."
        case .enToZh:
            return "Translate the English text into natural Simplified Chinese. Output ONLY the clean translation result, with absolutely no explanation, reasoning process, formatting, introduction, or repeating."
        case .detail:
            if containsChinese(text) {
                return "你是一个多角度翻译与例句助手。请分析输入的中文内容，提供其对应的多种英文单词或短语（分点列出），并针对每一个候选词/短语注明词性（若是单单词）、语境释义差异，以及附带高质量的英文例句与中文翻译。绝对不要输出任何音标。只输出 Markdown 格式的排版结果，不要包含任何前言介绍、解释性废话或将结果包裹在代码块中。"
            } else {
                return "你是一个词汇解析助手。请分析输入的英文内容。如果是单个单词，请给出词性（如：n. / v. 等）；如果是短语/词组，则忽略并不要输出词性。以无序列表分点形式给出多个准确的中文释义。针对该词汇，提供 2-3 个英文例句并附带对应的中文翻译。绝对不要输出任何音标。只输出 Markdown 格式的排版结果，不要包含任何前言介绍、解释性废话或将结果包裹在代码块中。"
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
