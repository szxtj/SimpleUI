import Combine
import Foundation

private struct StoreData: Codable {
    var activeMode: TranslationServiceMode
    var localRecords: [TranslationProfileRecord]
    var cloudRecords: [TranslationProfileRecord]
    var activeLocalRecordId: UUID
    var activeCloudRecordId: UUID
}

@MainActor
public final class TranslationProfileStore: ObservableObject {
    public static let shared = TranslationProfileStore()

    private let storageKey = "simpleui_translator_profiles_v1"

    @Published public var activeMode: TranslationServiceMode
    @Published public var localRecords: [TranslationProfileRecord]
    @Published public var cloudRecords: [TranslationProfileRecord]
    @Published public var activeLocalRecordId: UUID
    @Published public var activeCloudRecordId: UUID

    public init() {
        let defaults = UserDefaults.standard
        if let data = defaults.data(forKey: storageKey),
            let decoded = try? JSONDecoder().decode(StoreData.self, from: data)
        {
            self.activeMode = decoded.activeMode
            self.localRecords =
                decoded.localRecords.isEmpty
                ? TranslationProfileRecord.defaultLocalRecords : decoded.localRecords
            self.cloudRecords =
                decoded.cloudRecords.isEmpty
                ? TranslationProfileRecord.defaultCloudRecords : decoded.cloudRecords
            self.activeLocalRecordId = decoded.activeLocalRecordId
            self.activeCloudRecordId = decoded.activeCloudRecordId

            if !self.localRecords.contains(where: { $0.id == self.activeLocalRecordId }) {
                self.activeLocalRecordId = self.localRecords.first?.id ?? UUID()
            }
            if !self.cloudRecords.contains(where: { $0.id == self.activeCloudRecordId }) {
                self.activeCloudRecordId = self.cloudRecords.first?.id ?? UUID()
            }
        } else {
            let locals = TranslationProfileRecord.defaultLocalRecords
            let clouds = TranslationProfileRecord.defaultCloudRecords

            self.activeMode = .local
            self.localRecords = locals
            self.cloudRecords = clouds
            self.activeLocalRecordId = locals[0].id
            self.activeCloudRecordId = clouds[0].id
        }

        syncToUserDefaults()
    }

    public var currentActiveRecord: TranslationProfileRecord {
        getRecord(for: activeMode)
    }

    public func getRecord(for mode: TranslationServiceMode) -> TranslationProfileRecord {
        switch mode {
        case .local:
            return localRecords.first(where: { $0.id == activeLocalRecordId })
                ?? localRecords.first
                ?? TranslationProfileRecord.defaultLocalRecords[0]
        case .cloud:
            return cloudRecords.first(where: { $0.id == activeCloudRecordId })
                ?? cloudRecords.first
                ?? TranslationProfileRecord.defaultCloudRecords[0]
        }
    }

    public func records(for mode: TranslationServiceMode) -> [TranslationProfileRecord] {
        switch mode {
        case .local:
            return localRecords
        case .cloud:
            return cloudRecords
        }
    }

    public func selectRecord(id: UUID, in mode: TranslationServiceMode) {
        switch mode {
        case .local:
            if localRecords.contains(where: { $0.id == id }) {
                activeLocalRecordId = id
            }
        case .cloud:
            if cloudRecords.contains(where: { $0.id == id }) {
                activeCloudRecordId = id
            }
        }
        persist()
        syncToUserDefaults()
    }

    public func switchMode(to mode: TranslationServiceMode) {
        guard activeMode != mode else { return }
        activeMode = mode
        persist()
        syncToUserDefaults()
    }

    public func saveRecord(_ record: TranslationProfileRecord, makeActive: Bool = true) {
        switch record.mode {
        case .local:
            if let index = localRecords.firstIndex(where: { $0.id == record.id }) {
                localRecords[index] = record
            } else {
                localRecords.append(record)
            }
            if makeActive {
                activeLocalRecordId = record.id
                activeMode = .local
            }
        case .cloud:
            if let index = cloudRecords.firstIndex(where: { $0.id == record.id }) {
                cloudRecords[index] = record
            } else {
                cloudRecords.append(record)
            }
            if makeActive {
                activeCloudRecordId = record.id
                activeMode = .cloud
            }
        }
        persist()
        syncToUserDefaults()
    }

    public func deleteRecord(id: UUID, in mode: TranslationServiceMode) {
        switch mode {
        case .local:
            guard localRecords.count > 1 else { return }
            localRecords.removeAll(where: { $0.id == id })
            if activeLocalRecordId == id {
                activeLocalRecordId = localRecords.first?.id ?? UUID()
            }
        case .cloud:
            guard cloudRecords.count > 1 else { return }
            cloudRecords.removeAll(where: { $0.id == id })
            if activeCloudRecordId == id {
                activeCloudRecordId = cloudRecords.first?.id ?? UUID()
            }
        }
        persist()
        syncToUserDefaults()
    }

    public func persist() {
        let data = StoreData(
            activeMode: activeMode,
            localRecords: localRecords,
            cloudRecords: cloudRecords,
            activeLocalRecordId: activeLocalRecordId,
            activeCloudRecordId: activeCloudRecordId
        )
        if let encoded = try? JSONEncoder().encode(data) {
            UserDefaults.standard.set(encoded, forKey: storageKey)
        }
    }

    public func syncToUserDefaults() {
        let active = currentActiveRecord
        let defaults = UserDefaults.standard
        defaults.set(active.apiEndpoint, forKey: "simpleui_translator_api_endpoint")
        defaults.set(active.selectedModel, forKey: "simpleui_translator_model")
        defaults.set(active.apiKey, forKey: "simpleui_translator_api_key")
        defaults.set(active.temperature, forKey: "simpleui_translator_temperature")
        defaults.set(activeMode.rawValue, forKey: "simpleui_translator_mode")
    }

    /// 从前端通过 WKScriptMessageHandler 回传的 JSON 字典中热同步配置
    public func updateFromWebDict(_ dict: [String: Any]) {
        let defaults = UserDefaults.standard
        if let provider = dict["activeProvider"] as? String ?? dict["apiProvider"] as? String {
            defaults.set(provider, forKey: "simpleui_translator_api_provider")
        }
        if let endpoint = dict["activeEndpoint"] as? String {
            defaults.set(endpoint, forKey: "simpleui_translator_api_endpoint")
        }
        if let model = dict["activeModel"] as? String {
            defaults.set(model, forKey: "simpleui_translator_model")
        }
        if let apiKey = dict["activeApiKey"] as? String {
            defaults.set(apiKey, forKey: "simpleui_translator_api_key")
        }
        if let temp = dict["activeTemperature"] as? Double {
            defaults.set(temp, forKey: "simpleui_translator_temperature")
        }
        if let effort = dict["activeReasoningEffort"] as? String {
            defaults.set(effort, forKey: "simpleui_translator_reasoning_effort")
        }
        if let data = try? JSONSerialization.data(withJSONObject: dict) {
            defaults.set(data, forKey: "simpleui_translator_settings_raw")
        }

        if let modeStr = dict["activeMode"] as? String,
           let mode = TranslationServiceMode(rawValue: modeStr) {
            self.activeMode = mode
        }

        func parseRecords(_ rawList: [[String: Any]], mode: TranslationServiceMode) -> [TranslationProfileRecord] {
            return rawList.compactMap { item in
                let idStr = item["id"] as? String ?? ""
                let id = UUID(uuidString: idStr) ?? UUID()
                let name = (item["name"] as? String) ?? "未命名"
                let endpoint = (item["apiEndpoint"] as? String) ?? (mode == .local ? "http://127.0.0.1:1235/v1" : "https://api.deepseek.com/v1")
                let apiKey = (item["apiKey"] as? String) ?? ""
                let model = (item["selectedModel"] as? String) ?? (mode == .local ? "gemma-4-26b-a4b-it" : "deepseek-flash")
                let temp = (item["temperature"] as? Double) ?? 1.0
                return TranslationProfileRecord(id: id, name: name, mode: mode, apiEndpoint: endpoint, apiKey: apiKey, selectedModel: model, temperature: temp)
            }
        }

        if let localList = dict["localRecords"] as? [[String: Any]] {
            let parsed = parseRecords(localList, mode: .local)
            if !parsed.isEmpty {
                self.localRecords = parsed
            }
        }

        if let cloudList = dict["cloudRecords"] as? [[String: Any]] {
            let parsed = parseRecords(cloudList, mode: .cloud)
            if !parsed.isEmpty {
                self.cloudRecords = parsed
            }
        }

        if let activeLocalStr = dict["activeLocalRecordId"] as? String,
           let uuid = UUID(uuidString: activeLocalStr) {
            self.activeLocalRecordId = uuid
        }
        if let activeCloudStr = dict["activeCloudRecordId"] as? String,
           let uuid = UUID(uuidString: activeCloudStr) {
            self.activeCloudRecordId = uuid
        }

        persist()
    }
}
