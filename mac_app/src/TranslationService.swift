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
        let hasChinese = containsChinese(text)
        let isZhBase = (baseLang != "en")

        switch mode {
        case .quick:
            if isZhBase {
                if hasChinese {
                    // 情况 1-1：中文基准 · 中译英快速 (明确美式日常英语)
                    return """
                        Translate the following Chinese text into natural, idiomatic American everyday English.
                        Return only the translation result.
                        Do not explain anything.

                        Text:
                        \(text)
                        """
                } else {
                    // 情况 1-2：中文基准 · 英译中快速
                    return """
                        Translate the following English text into natural Simplified Chinese.
                        Return only the translation result.
                        Do not explain anything.

                        Text:
                        \(text)
                        """
                }
            } else {
                if hasChinese {
                    // 情况 2-1：英文基准 · 中译英快速
                    return """
                        Translate the following Chinese text into natural, idiomatic English.
                        Return only the translation result.
                        Do not explain anything.

                        Text:
                        \(text)
                        """
                } else {
                    // 情况 2-2：英文基准 · 英译中快速
                    return """
                        Translate the following English text into natural Simplified Chinese.
                        Return only the translation result.
                        Do not explain anything.

                        Text:
                        \(text)
                        """
                }
            }

        case .detail:
            if isZhBase {
                if hasChinese {
                    // 情况 1-3：中文基准 · 中译英详解 (优先美式日常表达，展示全面，英式加【英】)
                    return """
                        你是一个多角度中译英翻译与表达助手。请分析输入的中文内容：
                        1. 列出该中文对应的多个英文单词或短语（分点列出）：
                           - 优先推荐美式日常英语表达（日常口语、高频用法）。
                           - 尽量展示全面的不同表达（包含口语、书面、正式度不同的替代表达）。
                           - 如果包含英式英语特有表达，请在该表达前明确注明【英】（如【英】lift）。
                        2. 对于每一个候选英文表达，提供：
                           - 词性 (Part of speech，若为单单词则提供)
                           - 语境与语气辨析 (简要说明适用场景，如美式口语/书面正式/口语俚语等)
                           - 双语例句 (至少提供一个高质量地道的英文例句及中文对照翻译)

                        注意约束：
                        - 绝对不要输出任何音标。
                        - 只输出 Markdown 格式的排版结果，不要包含任何前言介绍、解释性废话或代码块。

                        输入内容：
                        \(text)
                        """
                } else {
                    // 情况 1-4：中文基准 · 英译中详解
                    return """
                        你是一个词汇与表达解析助手。请分析输入的英文内容：
                        1. 判断输入是单个单词还是短语/句子。如果是单个单词，请给出词性（如：n. / v. / adj.）；如果是短语或词组，请忽略并不要输出词性。
                        2. 以无序列表（分点）形式给出多个准确、有层次的中文释义。
                        3. 针对该词汇或短语，提供 2-3 个生动实用的英文例句，并附带对应的地道中文翻译。
                        4. 若有常用固定搭配或易混淆点，请作简要提示。

                        注意约束：
                        - 绝对不要输出任何音标。
                        - 只输出 Markdown 格式的排版结果，不要包含任何前言介绍、解释性废话或代码块。

                        输入内容：
                        \(text)
                        """
                }
            } else {
                if hasChinese {
                    // 情况 2-3：英文基准 · 中文输入详解 (向英文用户解释中文，全英文输出)
                    return """
                        You are a Chinese language and vocabulary tutor for English speakers. Analyze the following Chinese input:
                        1. Pinyin: Provide the accurate Pinyin with tone marks.
                        2. Part of Speech: If it is a word, specify its part of speech in English (e.g., Noun, Verb, Adjective).
                        3. English Definitions: Provide clear, bulleted definitions explaining the literal and contextual meanings.
                        4. Nuance & Usage Notes: Explain when and how this expression is used in modern Chinese (formality, register, cultural context).
                        5. Example Sentences: Provide 2-3 authentic example sentences in Chinese characters, accompanied by Pinyin and natural English translations.

                        Constraints:
                        - Output ONLY clean Markdown formatting.
                        - Do NOT include any introductory chit-chat, preamble, or code block wrapper.

                        Input text:
                        \(text)
                        """
                } else {
                    // 情况 2-4：英文基准 · 英文输入详解 (向英文用户展示如何用地道中文表达，全英文输出)
                    return """
                        You are an English-to-Chinese translation and vocabulary consultant for English speakers. Analyze the following English input:
                        1. Chinese Equivalents: List 2-4 authentic Chinese translations (Simplified Chinese characters accompanied by Pinyin).
                        2. Nuance Breakdown: For each Chinese equivalent, explain in English its specific nuance, register (formal, informal, colloquial), and context where it is preferred over others.
                        3. Example Sentences: Provide practical bilingual example sentences (English original and Chinese translation with Pinyin) for each major equivalent.

                        Constraints:
                        - Output ONLY clean Markdown formatting.
                        - Do NOT include any introductory chit-chat, preamble, or code block wrapper.

                        Input text:
                        \(text)
                        """
                }
            }
        }
    }

    public static func makeSystemInstruction(for mode: TranslationMode, text: String, baseLang: String = "zh") -> String {
        let hasChinese = containsChinese(text)
        let isZhBase = (baseLang != "en")

        switch mode {
        case .quick:
            if isZhBase {
                if hasChinese {
                    // 情况 1-1：中文基准 · 中译英快速 (明确美式日常英语)
                    return "Translate the Chinese text into natural, idiomatic American everyday English. Output ONLY the clean translation result, with absolutely no explanation, reasoning process, formatting, introduction, phonetics, or repeating."
                } else {
                    // 情况 1-2：中文基准 · 英译中快速
                    return "Translate the English text into natural Simplified Chinese. Output ONLY the clean translation result, with absolutely no explanation, reasoning process, formatting, introduction, phonetics, or repeating."
                }
            } else {
                if hasChinese {
                    // 情况 2-1：英文基准 · 中译英快速
                    return "Translate the Chinese text into natural, idiomatic English. Output ONLY the clean translation result, with absolutely no explanation, reasoning process, formatting, introduction, phonetics, or repeating."
                } else {
                    // 情况 2-2：英文基准 · 英译中快速
                    return "Translate the English text into natural Simplified Chinese. Output ONLY the clean translation result, with absolutely no explanation, reasoning process, formatting, introduction, phonetics, or repeating."
                }
            }

        case .detail:
            if isZhBase {
                if hasChinese {
                    // 情况 1-3：中文基准 · 中译英详解 (优先美式日常表达，展示全面，英式加【英】)
                    return "你是一个多角度中译英翻译与表达助手。请分析输入的中文内容，提供对应的地道英文表达：1. 优先推荐美式日常英语表达（高频、自然的日常口语或常用用法）；2. 同时尽量展示全面的不同表达（包含口语、书面、正式度不同的替代表达）；3. 若提供英式英语特有表达，请在词条或短语前明确标注【英】（如【英】lift）；4. 针对候选表达注明词性（若是单单词）、语境与语气辨析，并提供高质量的英文例句与中文对照翻译。绝对不要输出任何音标。只输出 Markdown 格式的排版结果，不要包含任何前言介绍、寒暄或将结果包裹在代码块中。"
                } else {
                    // 情况 1-4：中文基准 · 英译中详解
                    return "你是一个词汇与表达解析助手。请分析输入的英文内容：如果是单个单词，请给出词性（如：n. / v. / adj. 等）；如果是短语/词组，则忽略并不要输出词性。以无序列表分点形式给出多个准确的中文释义。针对该词汇或短语，提供 2-3 个生动实用的英文例句并附带对应的地道中文翻译。绝对不要输出任何音标。只输出 Markdown 格式的排版结果，不要包含任何前言介绍、解释性废话或将结果包裹在代码块中。"
                }
            } else {
                if hasChinese {
                    // 情况 2-3：英文基准 · 中文输入详解 (向英文用户解释中文)
                    return "You are a Chinese-to-English language and vocabulary tutor for English speakers. Analyze the provided Chinese text: 1. Provide the Pinyin with tone marks; 2. State the part of speech if it is a word; 3. Provide comprehensive English definitions with nuanced meanings; 4. Explain the cultural or pragmatic usage context in English; 5. Provide 2-3 authentic example sentences with Chinese characters, Pinyin, and English translations. Output ONLY clean Markdown with no conversational filler, prelude, or code block wrapper."
                } else {
                    // 情况 2-4：英文基准 · 英文输入详解 (向英文用户展示如何用地道中文表达)
                    return "You are an English-to-Chinese translation and vocabulary consultant for English speakers. Analyze the provided English text: 1. Provide multiple accurate Chinese translations (Simplified Chinese characters with Pinyin); 2. Explain the differences, nuances, formality levels, and contexts between each Chinese alternative in English; 3. Provide 2-3 bilingual example sentences showing how each Chinese term is used naturally. Output ONLY clean Markdown with no conversational filler, prelude, or code block wrapper."
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
