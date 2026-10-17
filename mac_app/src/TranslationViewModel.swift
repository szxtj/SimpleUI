import AppKit
import Foundation
import Combine

@MainActor
public final class TranslationViewModel: ObservableObject {
    @Published public var inputText = ""
    @Published public var outputText = ""
    @Published public var isLoading = false
    @Published public var selectedMode: TranslationMode = .auto
    @Published public var errorMessage: String?
    @Published public private(set) var focusToken = 0
    @Published public var isSpeaking = false
    @Published public var isSpeakingInput = false
    @Published public var isSpeakingOutput = false
    @Published public var isZh: Bool = AppLocale.isZh
    @Published public var isDark: Bool = UserDefaults.standard.bool(forKey: "simpleui_is_dark")

    private let service: TranslationServiceProtocol
    private let speechManager = TranslationSpeechManager()
    private var cancellables = Set<AnyCancellable>()
    private var currentTranslationTask: Task<Void, Never>?

    public init(service: TranslationServiceProtocol = TranslationService()) {
        self.service = service

        speechManager.$isSpeaking
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

    public func cancelTranslation() {
        guard isLoading else { return }
        currentTranslationTask?.cancel()
        currentTranslationTask = nil
        isLoading = false
        stopSpeech()
        errorMessage = isZh ? "已终止翻译。" : "Translation stopped."
    }

    public func startTranslation() {
        let trimmedInput = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedInput.isEmpty else { return }
        guard !isLoading else { return }

        currentTranslationTask?.cancel()
        currentTranslationTask = Task {
            await performTranslation()
        }
    }

    public func performTranslation() async {
        let trimmedInput = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedInput.isEmpty else { return }

        stopSpeech()
        isLoading = true
        errorMessage = nil

        do {
            outputText = try await service.translate(text: trimmedInput, mode: selectedMode)
        } catch is CancellationError {
            errorMessage = isZh ? "已终止翻译。" : "Translation stopped."
        } catch let error as TranslationServiceError where error == .cancelled {
            errorMessage = isZh ? "已终止翻译。" : "Translation stopped."
        } catch {
            outputText = ""
            errorMessage = Self.message(for: error)
        }

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

    public func toggleSpeech() {
        if isSpeakingOutput {
            stopSpeech()
        } else {
            isSpeakingInput = false
            isSpeakingOutput = true
            speechManager.speak(text: outputText)
        }
    }

    public func toggleInputSpeech() {
        if isSpeakingInput {
            stopSpeech()
        } else {
            isSpeakingInput = true
            isSpeakingOutput = false
            speechManager.speak(text: inputText)
        }
    }

    public func stopSpeech() {
        speechManager.stop()
    }

    public func refreshLocaleAndTheme() {
        isZh = AppLocale.isZh
        isDark = UserDefaults.standard.bool(forKey: "simpleui_is_dark")
    }

    private static func message(for error: Error) -> String {
        if let translationError = error as? TranslationServiceError {
            return translationError.errorDescription ?? (AppLocale.isZh ? "翻译失败。" : "Translation failed.")
        }
        return error.localizedDescription
    }
}
