import AppKit
import Foundation
import Combine

@MainActor
public final class TranslationViewModel: ObservableObject {
    @Published public var inputText = ""
    @Published public var outputText = ""
    /// 结果区当前选中的文本（仅用于「划选朗读」）。
    @Published public var selectedOutputText = ""
    /// 递增后通知结果文本视图清空原生选区。
    @Published public private(set) var outputSelectionResetToken = 0
    @Published public var isLoading = false
    @Published public var selectedMode: TranslationMode = .quick
    @Published public var errorMessage: String?
    @Published public private(set) var focusToken = 0
    @Published public var isSpeaking = false
    @Published public var isSpeakingInput = false
    @Published public var isSpeakingOutput = false
    @Published public var isZh: Bool = AppLocale.isZh
    @Published public var baseLang: String = UserDefaults.standard.string(forKey: "simpleui_translator_base_lang") ?? "zh"

    private let service: TranslationServiceProtocol
    private let speechManager = TranslationSpeechManager()
    private var cancellables = Set<AnyCancellable>()
    private var currentTranslationTask: Task<Void, Never>?
    /// 每次新请求 / 取消都自增；旧请求的收尾逻辑据此丢弃，避免覆盖新请求的 isLoading / outputText。
    private var translationGeneration = 0

    public init(service: TranslationServiceProtocol = TranslationService()) {
        self.service = service

        speechManager.$isSpeaking
            .removeDuplicates()
            .sink { [weak self] isSpeaking in
                guard let self = self else { return }
                self.isSpeaking = isSpeaking
                if !isSpeaking {
                    self.isSpeakingInput = false
                    self.isSpeakingOutput = false
                }
            }
            .store(in: &cancellables)

        $inputText
            .sink { [weak self] _ in
                self?.stopSpeech()
            }
            .store(in: &cancellables)
    }

    public func submit() {
        if isLoading {
            cancelTranslation()
        } else {
            startTranslation()
        }
    }

    /// 清空结果区选区：新结果、切换模式、关闭窗口时调用。
    public func clearOutputSelection() {
        if !selectedOutputText.isEmpty {
            selectedOutputText = ""
        }
        outputSelectionResetToken &+= 1
    }

    public func cancelTranslation() {
        guard isLoading else { return }
        translationGeneration &+= 1
        currentTranslationTask?.cancel()
        currentTranslationTask = nil
        isLoading = false
        stopSpeech()
        errorMessage = isZh ? "已终止翻译。" : "Translation stopped."
    }

    /// 划选翻译入口：取消上一轮请求，清空旧结果，把纯文本载入并切到指定模式。
    /// 由原生控制器在窗口展示后调用 startTranslation() 自动发起翻译。
    public func loadSelectionText(_ text: String, mode: TranslationMode) {
        translationGeneration &+= 1
        currentTranslationTask?.cancel()
        currentTranslationTask = nil
        isLoading = false
        stopSpeech()
        errorMessage = nil
        outputText = ""
        clearOutputSelection()
        selectedMode = mode
        inputText = text
    }

    public func startTranslation() {
        let trimmedInput = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedInput.isEmpty else { return }
        guard !isLoading else { return }

        translationGeneration &+= 1
        let generation = translationGeneration
        currentTranslationTask?.cancel()
        currentTranslationTask = Task { [weak self] in
            await self?.performTranslation(generation: generation)
        }
    }

    public func performTranslation() async {
        translationGeneration &+= 1
        await performTranslation(generation: translationGeneration)
    }

    private func performTranslation(generation: Int) async {
        let trimmedInput = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedInput.isEmpty else { return }

        stopSpeech()
        clearOutputSelection()
        isLoading = true
        errorMessage = nil

        do {
            let result = try await service.translate(
                text: trimmedInput, mode: selectedMode, baseLang: baseLang)
            guard generation == translationGeneration else { return }
            outputText = result
            // 加载期间用户可能选中了旧结果，新结果落盘后统一清空。
            clearOutputSelection()
        } catch is CancellationError {
            guard generation == translationGeneration else { return }
            errorMessage = isZh ? "已终止翻译。" : "Translation stopped."
        } catch let error as TranslationServiceError where error == .cancelled {
            guard generation == translationGeneration else { return }
            errorMessage = isZh ? "已终止翻译。" : "Translation stopped."
        } catch {
            guard generation == translationGeneration else { return }
            outputText = ""
            clearOutputSelection()
            errorMessage = Self.message(for: error)
        }

        guard generation == translationGeneration else { return }
        isLoading = false
        currentTranslationTask = nil
    }

    public func requestFocus() {
        focusToken += 1
    }

    public func copyResult() {
        let trimmedOutput = outputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedOutput.isEmpty else { return }

        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(trimmedOutput, forType: .string)
    }

    /// 朗读指定文本。详解模式传入选区文本，快速模式传入完整结果。
    public func toggleOutputSpeech(_ text: String) {
        if isSpeakingOutput {
            stopSpeech()
            return
        }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        if isSpeakingInput {
            stopSpeech()
        }

        speechManager.speak(text: trimmed)
        // speak() 内部会先 stop() 一次；在调用结束后再落状态，确保按钮保持可停止。
        isSpeakingInput = false
        isSpeakingOutput = true
    }

    public func toggleInputSpeech() {
        if isSpeakingInput {
            stopSpeech()
            return
        }

        let trimmed = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        if isSpeakingOutput {
            stopSpeech()
        }

        speechManager.speak(text: trimmed)
        isSpeakingOutput = false
        isSpeakingInput = true
    }

    public func stopSpeech() {
        speechManager.stop()
    }

    public func refreshLocaleAndSettings() {
        isZh = AppLocale.isZh
        baseLang = UserDefaults.standard.string(forKey: "simpleui_translator_base_lang") ?? "zh"
    }

    private static func message(for error: Error) -> String {
        if let translationError = error as? TranslationServiceError {
            return translationError.errorDescription ?? (AppLocale.isZh ? "翻译失败。" : "Translation failed.")
        }
        return error.localizedDescription
    }
}
