import SwiftUI

struct TranslationMainView: View {
    @ObservedObject var viewModel: TranslationViewModel
    let onPreferredHeightChange: (CGFloat) -> Void
    let onClose: () -> Void

    private var isZh: Bool { viewModel.isZh }

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
                .padding(.trailing, 6)
                .padding(.bottom, 6)
                .help(isZh ? "朗读输入文本" : "Speak Input")
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

                ScrollView {
                    Text(renderedOutput)
                        .foregroundStyle(viewModel.outputText.isEmpty ? .secondary : .primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(height: resultHeight)

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
                    isZh
                        ? "Enter 翻译 · Shift+Enter 换行 · Esc 退出 (⌃Space)"
                        : "Enter: Translate · Shift+Enter: Newline · Esc: Close (⌃Space)"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                .layoutPriority(1)

                TranslationWindowDragView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                Button(action: {
                    viewModel.toggleSpeech()
                }) {
                    Image(
                        systemName: viewModel.isSpeakingOutput
                            ? "speaker.wave.3.fill" : "speaker.wave.2.fill"
                    )
                    .foregroundColor(viewModel.isSpeakingOutput ? .accentColor : .primary)
                }
                .buttonStyle(.bordered)
                .disabled(
                    viewModel.outputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
                .help(isZh ? "朗读翻译结果" : "Speak Translation")

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
        .preferredColorScheme(viewModel.isDark ? .dark : .light)
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
    }

    private var renderedOutput: AttributedString {
        guard !viewModel.outputText.isEmpty else {
            return AttributedString(isZh ? "翻译结果将显示在这里…" : "Translation result will appear here...")
        }
        do {
            return try AttributedString(
                markdown: viewModel.outputText,
                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
            )
        } catch {
            return AttributedString(viewModel.outputText)
        }
    }

    private var inputHeight: CGFloat {
        estimatedHeight(for: viewModel.inputText, min: 86, max: 180)
    }

    private var resultHeight: CGFloat {
        let placeholder = isZh ? "翻译结果将显示在这里…" : "Translation result will appear here..."
        return estimatedHeight(
            for: viewModel.outputText.isEmpty ? placeholder : viewModel.outputText,
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
