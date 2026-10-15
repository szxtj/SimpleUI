import Foundation

public enum TranslationServiceMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case local = "local"
    case cloud = "cloud"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .local:
            return "本地 (Local)"
        case .cloud:
            return "云端 (Cloud)"
        }
    }

    public var iconName: String {
        switch self {
        case .local:
            return "desktopcomputer"
        case .cloud:
            return "cloud"
        }
    }
}

public struct TranslationProfileRecord: Identifiable, Codable, Equatable, Hashable, Sendable {
    public var id: UUID
    public var name: String
    public var mode: TranslationServiceMode
    public var apiEndpoint: String
    public var apiKey: String
    public var selectedModel: String
    public var temperature: Double

    public init(
        id: UUID = UUID(),
        name: String,
        mode: TranslationServiceMode,
        apiEndpoint: String,
        apiKey: String = "",
        selectedModel: String,
        temperature: Double = 0.2
    ) {
        self.id = id
        self.name = name
        self.mode = mode
        self.apiEndpoint = apiEndpoint
        self.apiKey = apiKey
        self.selectedModel = selectedModel
        self.temperature = temperature
    }

    public func validate() -> String? {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedName.isEmpty {
            return "配置名称不能为空。"
        }

        let trimmedEndpoint = apiEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedEndpoint.isEmpty {
            return "API Base URL 不能为空。"
        }

        guard let url = URL(string: trimmedEndpoint),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https"
        else {
            return "API Base URL 格式无效（必须以 http:// 或 https:// 开头）。"
        }

        let trimmedModel = selectedModel.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedModel.isEmpty {
            return "模型名称不能为空。"
        }

        return nil
    }

    public static let defaultLocalRecords: [TranslationProfileRecord] = [
        TranslationProfileRecord(
            name: "SimpleUI (内置模型)",
            mode: .local,
            apiEndpoint: "http://127.0.0.1:1235/v1",
            apiKey: "",
            selectedModel: "local-model",
            temperature: 0.2
        ),
        TranslationProfileRecord(
            name: "LM Studio",
            mode: .local,
            apiEndpoint: "http://localhost:1234/v1",
            apiKey: "",
            selectedModel: "local-model",
            temperature: 0.2
        ),
        TranslationProfileRecord(
            name: "Ollama",
            mode: .local,
            apiEndpoint: "http://localhost:11434/v1",
            apiKey: "",
            selectedModel: "qwen2.5:7b",
            temperature: 0.2
        ),
    ]

    public static let defaultCloudRecords: [TranslationProfileRecord] = [
        TranslationProfileRecord(
            name: "DeepSeek",
            mode: .cloud,
            apiEndpoint: "https://api.deepseek.com/v1",
            apiKey: "",
            selectedModel: "deepseek-chat",
            temperature: 0.2
        ),
        TranslationProfileRecord(
            name: "OpenAI",
            mode: .cloud,
            apiEndpoint: "https://api.openai.com/v1",
            apiKey: "",
            selectedModel: "gpt-4o-mini",
            temperature: 0.2
        ),
    ]
}

public enum TranslationMode: String, CaseIterable, Identifiable, Sendable {
    case auto
    case zhToEn
    case enToZh
    case detail

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .auto:
            return "自动"
        case .zhToEn:
            return "中 → 英"
        case .enToZh:
            return "英 → 中"
        case .detail:
            return "详解"
        }
    }
}
