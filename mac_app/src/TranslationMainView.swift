import AppKit
import SwiftUI

struct TranslationMainView: View {
    @ObservedObject var viewModel: TranslationViewModel
    let onPreferredHeightChange: (CGFloat) -> Void
    let onClose: () -> Void

    private var isZh: Bool { viewModel.isZh }
    private var canSubmit: Bool {
        !viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var isDetailMode: Bool {
        viewModel.selectedMode == .detail
    }
    /// 详解模式只朗读选区；快速模式保持一键朗读整段结果。
    private var outputSpeechText: String {
        isDetailMode ? viewModel.selectedOutputText : viewModel.outputText
    }
    private var canSpeakOutput: Bool {
        if viewModel.isSpeakingOutput { return true }
        return !outputSpeechText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var resultPlaceholder: String {
        isZh ? "翻译结果将显示在这里…" : "Translation result will appear here..."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            // Header bar
            HStack {
                Button(action: onClose) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help(isZh ? "关闭 (Esc)" : "Close (Esc)")

                TranslationWindowDragView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(height: 18)

            // Mode Selector
            Picker("", selection: $viewModel.selectedMode) {
                ForEach(TranslationMode.allCases) { mode in
                    Text(mode.localizedTitle(isZh: isZh)).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            // Input Area
            ZStack(alignment: .bottomTrailing) {
                TranslationInputTextView(
                    text: $viewModel.inputText,
                    focusToken: viewModel.focusToken,
                    isEditable: !viewModel.isLoading,
                    onSubmit: {
                        viewModel.submit()
                    },
                    onEscape: onClose
                )
                .frame(height: inputHeight)

                HStack(spacing: 6) {
                    Button(action: {
                        viewModel.toggleInputSpeech()
                    }) {
                        Image(
                            systemName: viewModel.isSpeakingInput
                                ? "speaker.wave.3.fill" : "speaker.wave.2.fill"
                        )
                        .foregroundColor(viewModel.isSpeakingInput ? .accentColor : .primary)
                    }
                    .buttonStyle(.bordered)
                    .disabled(
                        viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                    .help(isZh ? "朗读输入文本" : "Speak Input")

                    Button(action: {
                        viewModel.submit()
                    }) {
                        ZStack {
                            if viewModel.isLoading {
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .fill(Color.red)
                                    .frame(width: 26, height: 26)
                                Image(systemName: "stop.fill")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundColor(.white)
                            } else {
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .fill(canSubmit ? Color.accentColor : Color.secondary.opacity(0.18))
                                    .frame(width: 26, height: 26)
                                Image(systemName: "arrow.up")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundColor(canSubmit ? .white : Color.secondary.opacity(0.6))
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(!viewModel.isLoading && !canSubmit)
                    .help(
                        viewModel.isLoading
                            ? (isZh ? "终止翻译 (Enter)" : "Stop Translation (Enter)")
                            : (isZh ? "翻译 (Enter)" : "Translate (Enter)")
                    )
                }
                .padding(.trailing, 6)
                .padding(.bottom, 6)
            }

            // Translation Output Area
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(isZh ? "翻译结果" : "Translation")
                        .font(.headline)

                    TranslationWindowDragView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)

                    if viewModel.isLoading {
                        ProgressView()
                            .controlSize(.small)
                    }
                }
                .frame(height: 20)

                TranslationResultTextView(
                    text: viewModel.outputText,
                    placeholder: resultPlaceholder,
                    selectedText: $viewModel.selectedOutputText,
                    resetToken: viewModel.outputSelectionResetToken,
                    onSubmit: {
                        viewModel.submit()
                        viewModel.requestFocus()
                    },
                    onEscape: onClose
                )
                .frame(height: resultHeight)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(
                            viewModel.selectedOutputText.isEmpty
                                ? Color.white.opacity(0.10)
                                : Color.accentColor.opacity(0.45),
                            lineWidth: 1
                        )
                )
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                if let errorMessage = viewModel.errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // Bottom action bar
            HStack {
                Text(
                    viewModel.isLoading
                        ? (isZh
                            ? "Enter 终止翻译 · Esc 退出"
                            : "Enter: Stop · Esc: Close")
                        : (isZh
                            ? "Enter 翻译 · Shift+Enter 换行 · Esc 退出 (⌃Space)"
                            : "Enter: Translate · Shift+Enter: Newline · Esc: Close (⌃Space)")
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                .layoutPriority(1)

                TranslationWindowDragView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                HStack(spacing: 0) {
                    Button(action: {
                        viewModel.toggleOutputSpeech(outputSpeechText)
                    }) {
                        Image(
                            systemName: viewModel.isSpeakingOutput
                                ? "speaker.wave.3.fill" : "speaker.wave.2.fill"
                        )
                        .foregroundColor(viewModel.isSpeakingOutput ? .accentColor : .primary)
                    }
                    .buttonStyle(.bordered)
                    .disabled(!canSpeakOutput)
                    .onHover { hovering in
                        if hovering {
                            NSCursor.arrow.set()
                        }
                    }
                }
                // 禁用状态下 SwiftUI 的 help 可能不触发，用透明层承接 hover 和提示。
                // overlay 不参与布局，避免透明层把按钮撑满底栏。
                .overlay {
                    if !canSpeakOutput {
                        Color.clear
                            .contentShape(Rectangle())
                            .help(outputSpeechHelp)
                            .onHover { hovering in
                                if hovering {
                                    NSCursor.arrow.set()
                                }
                            }
                    }
                }
                .help(outputSpeechHelp)

                Button(isZh ? "复制" : "Copy") {
                    viewModel.copyResult()
                }
                .keyboardShortcut("c")
                .disabled(
                    viewModel.outputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            }
        }
        .padding(18)
        .frame(width: 620)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(.regularMaterial)
                TranslationWindowDragView()
            }
        )
        .preferredColorScheme(.dark)
        .onAppear {
            reportPreferredHeight()
        }
        .onChange(of: viewModel.inputText) { _ in
            reportPreferredHeight()
        }
        .onChange(of: viewModel.outputText) { _ in
            reportPreferredHeight()
        }
        .onChange(of: viewModel.errorMessage) { _ in
            reportPreferredHeight()
        }
        .onChange(of: viewModel.selectedMode) { _, _ in
            viewModel.clearOutputSelection()
        }
    }

    private var outputSpeechHelp: String {
        if viewModel.isSpeakingOutput {
            return isZh ? "停止朗读" : "Stop reading"
        }
        if viewModel.outputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return isZh ? "暂无翻译结果" : "No translation result yet"
        }
        if isDetailMode
            && viewModel.selectedOutputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return isZh
                ? "请先在结果中划选要朗读的文字"
                : "Select text in the result to read it aloud"
        }
        return isDetailMode
            ? (isZh ? "朗读选中内容" : "Read selected text")
            : (isZh ? "朗读翻译结果" : "Read translation")
    }

    private var inputHeight: CGFloat {
        estimatedHeight(for: viewModel.inputText, min: 86, max: 180)
    }

    private var resultHeight: CGFloat {
        estimatedHeight(
            for: viewModel.outputText.isEmpty ? resultPlaceholder : viewModel.outputText,
            min: 80,
            max: 220
        )
    }

    private func estimatedHeight(for text: String, min minHeight: CGFloat, max maxHeight: CGFloat)
        -> CGFloat
    {
        let lineBreakCount = text.reduce(into: 1) { partialResult, character in
            if character == "\n" {
                partialResult += 1
            }
        }
        let wrappedLineEstimate = Swift.max(1, Int(ceil(Double(text.count) / 36.0)))
        let lineCount = Swift.max(lineBreakCount, wrappedLineEstimate)
        let contentHeight = CGFloat(lineCount) * 22 + 28
        return Swift.min(maxHeight, Swift.max(minHeight, contentHeight))
    }

    private func reportPreferredHeight() {
        let totalHeight =
            inputHeight + resultHeight + 170 + (viewModel.errorMessage == nil ? 0 : 22)
        onPreferredHeightChange(totalHeight)
    }
}

struct TranslationWindowDragView: NSViewRepresentable {
    func makeNSView(context: Context) -> DragNSView {
        DragNSView()
    }

    func updateNSView(_ nsView: DragNSView, context: Context) {}

    final class DragNSView: NSView {
        override var mouseDownCanMoveWindow: Bool {
            true
        }

        override func mouseDown(with event: NSEvent) {
            window?.performDrag(with: event)
        }
    }
}
