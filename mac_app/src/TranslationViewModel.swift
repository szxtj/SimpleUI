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
        Task {
            await performTranslation()
        }
    }

    public func performTranslation() async {
        let trimmedInput = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedInput.isEmpty else { return }
        guard !isLoading else { return }

        stopSpeech()
        isLoading = true
        errorMessage = nil

        do {
            outputText = try await service.translate(text: trimmedInput, mode: selectedMode)
        } catch {
            outputText = ""
            errorMessage = Self.message(for: error)
        }

        isLoading = false
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
