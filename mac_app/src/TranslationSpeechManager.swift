import AVFoundation
import NaturalLanguage

@MainActor
final class TranslationSpeechManager: NSObject, AVSpeechSynthesizerDelegate, ObservableObject {
    @Published var isSpeaking = false

    private let synthesizer = AVSpeechSynthesizer()

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(text: String) {
        stop()

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let utterance = AVSpeechUtterance(string: trimmed)

        // Detect language using local NaturalLanguage framework
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(trimmed)
        let language = recognizer.dominantLanguage?.rawValue ?? "en"

        // Find available voice matching language code (e.g. prefix match like "zh" or "en")
        let voices = AVSpeechSynthesisVoice.speechVoices()
        let voiceLang = language.lowercased().starts(with: "zh") ? "zh" : "en"
        let matchedVoice = voices.first { $0.language.lowercased().starts(with: voiceLang) }

        if let voice = matchedVoice {
            utterance.voice = voice
        } else {
            let fallbackLang = voiceLang == "zh" ? "zh-CN" : "en-US"
            utterance.voice = AVSpeechSynthesisVoice(language: fallbackLang)
        }

        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.volume = 1.0

        synthesizer.speak(utterance)
        isSpeaking = true
    }

    func stop() {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        isSpeaking = false
    }

    // MARK: - AVSpeechSynthesizerDelegate

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.isSpeaking = true
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.isSpeaking = false
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.isSpeaking = false
        }
    }
}
