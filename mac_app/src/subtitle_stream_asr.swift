import Foundation
import CoreML
import Accelerate

// ============================================================================
// SimpleUI 原生流式语音识别守护进程 (subtitle_stream_asr)
// 模型: aufklarer/Nemotron-Speech-Streaming-0.6B-CoreML-INT8
// 架构: Cache-Aware FastConformer Encoder + 2-Layer LSTM Predictor + RNN-T Joint
// 硬件: Apple Neural Engine (16-Core NPU, computeUnits = .cpuAndNeuralEngine)
// 协议: stdin/stdout JSON Lines
//   - {"cmd": "push", "pcm_b64": "<Base64 Int16 16kHz Mono PCM>"}
//   - {"cmd": "reset", "hard": true|false}
// ============================================================================

struct CommandRequest: Codable {
    let cmd: String?
    let pcm_b64: String?
    let wav: String?
    let hard: Bool?
}

struct StreamResponse: Codable {
    let ok: Bool
    let text: String
    let delta: String
    let eou: Bool
    let npu_latency_ms: Double
    let hardware: String
    let error: String?
}

// MARK: - 16kHz Log-Mel 频谱提取器 (Accelerate / vDSP)

final class StreamingMelExtractor {
    let sampleRate: Int = 16000
    let winLength: Int = 400      // 25ms @ 16kHz
    let hopLength: Int = 160      // 10ms @ 16kHz
    let nFFT: Int = 512
    let nMels: Int
    let preemph: Float = 0.97

    private var window: [Float]
    private var filterbank: [[Float]] // [nMels][nFFT/2 + 1]
    private var sampleBuffer: [Float] = []
    private var prevSample: Float = 0.0

    init(nMels: Int = 80) {
        self.nMels = nMels
        self.window = [Float](repeating: 0, count: winLength)
        vDSP_hann_window(&self.window, vDSP_Length(winLength), Int32(vDSP_HANN_NORM))
        self.filterbank = Self.buildMelFilterbank(
            sampleRate: Float(sampleRate),
            nFFT: nFFT,
            nMels: nMels,
            fMin: 0.0,
            fMax: 8000.0
        )
    }

    func reset() {
        sampleBuffer.removeAll(keepingCapacity: true)
        prevSample = 0.0
    }

    func appendSamples(_ int16Samples: [Int16]) {
        sampleBuffer.reserveCapacity(sampleBuffer.count + int16Samples.count)
        for s in int16Samples {
            let f = Float(s) / 32768.0
            let emph = f - preemph * prevSample
            prevSample = f
            sampleBuffer.append(emph)
        }
    }

    var availableFrames: Int {
        guard sampleBuffer.count >= winLength else { return 0 }
        return 1 + (sampleBuffer.count - winLength) / hopLength
    }

    /// 弹出固定数量的 Mel 帧 (例如 16 帧 = 160ms 或 32 帧 = 320ms)，保留重叠采样点
    func popMelFrames(count: Int, consumeFrames: Int) -> [[Float]]? {
        guard availableFrames >= count else { return nil }
        let nFreqs = nFFT / 2 + 1
        var frames: [[Float]] = []
        frames.reserveCapacity(count)

        var real = [Float](repeating: 0, count: nFFT)
        var magSq = [Float](repeating: 0, count: nFreqs)

        for frameIdx in 0..<count {
            let start = frameIdx * hopLength
            for i in 0..<winLength {
                real[i] = sampleBuffer[start + i] * window[i]
            }
            for i in winLength..<nFFT {
                real[i] = 0
            }

            // 计算功率谱 (DFT on 512 points)
            for k in 0..<nFreqs {
                var re: Float = 0
                var im: Float = 0
                let omega = -2.0 * Float.pi * Float(k) / Float(nFFT)
                for n in 0..<winLength {
                    let angle = omega * Float(n)
                    re += real[n] * cosf(angle)
                    im += real[n] * sinf(angle)
                }
                magSq[k] = re * re + im * im
            }

            var melVec = [Float](repeating: 0, count: nMels)
            for m in 0..<nMels {
                var energy: Float = 0
                vDSP_dotpr(magSq, 1, filterbank[m], 1, &energy, vDSP_Length(nFreqs))
                melVec[m] = logf(max(energy, 1e-10))
            }
            frames.append(melVec)
        }

        let dropSamples = min(sampleBuffer.count, max(1, consumeFrames) * hopLength)
        sampleBuffer.removeFirst(dropSamples)
        return frames
    }

    private static func hzToMel(_ hz: Float) -> Float {
        return 2595.0 * log10f(1.0 + hz / 700.0)
    }

    private static func melToHz(_ mel: Float) -> Float {
        return 700.0 * (powf(10.0, mel / 2595.0) - 1.0)
    }

    private static func buildMelFilterbank(
        sampleRate: Float,
        nFFT: Int,
        nMels: Int,
        fMin: Float,
        fMax: Float
    ) -> [[Float]] {
        let nFreqs = nFFT / 2 + 1
        let melMin = hzToMel(fMin)
        let melMax = hzToMel(fMax)
        var melPoints = [Float](repeating: 0, count: nMels + 2)
        for i in 0..<(nMels + 2) {
            melPoints[i] = melToHz(melMin + Float(i) * (melMax - melMin) / Float(nMels + 1))
        }

        var fftFreqs = [Float](repeating: 0, count: nFreqs)
        for i in 0..<nFreqs {
            fftFreqs[i] = Float(i) * (sampleRate / 2.0) / Float(nFreqs - 1)
        }

        var weights = [[Float]](repeating: [Float](repeating: 0, count: nFreqs), count: nMels)
        for m in 0..<nMels {
            let fLeft = melPoints[m]
            let fCenter = melPoints[m + 1]
            let fRight = melPoints[m + 2]
            let enorm = 2.0 / max(1e-6, fRight - fLeft)
            for k in 0..<nFreqs {
                let freq = fftFreqs[k]
                if freq >= fLeft && freq <= fCenter && fCenter > fLeft {
                    weights[m][k] = ((freq - fLeft) / (fCenter - fLeft)) * enorm
                } else if freq > fCenter && freq <= fRight && fRight > fCenter {
                    weights[m][k] = ((fRight - freq) / (fRight - fCenter)) * enorm
                }
            }
        }
        return weights
    }
}

// MARK: - CoreML Nemotron Cache-Aware RNN-T 流式引擎

final class NemotronCoreMLStreamer {
    private let encoder: MLModel
    private let decoder: MLModel
    private let joint: MLModel
    private var vocab: [Int: String] = [:]
    private var blankId: Int = 1024
    private var eouId: Int = -1

    private var melExtractor: StreamingMelExtractor
    private var melInputName: String = "audio_signal"
    private var melLengthName: String? = nil
    private var melChannelsFirst: Bool = true
    private var melFramesPerChunk: Int = 16
    private var melConsumeFrames: Int = 16

    // 跨块持久化的 Encoder 与 Decoder 状态张量
    private var encoderStates: [String: MLMultiArray] = [:]
    private var decoderStates: [String: MLMultiArray] = [:]
    private var lastToken: Int = 1024
    private var accumulatedText: String = ""

    init(bundleDir: URL) throws {
        let encUrl = bundleDir.appendingPathComponent("encoder.mlmodelc")
        let decUrl = bundleDir.appendingPathComponent("decoder.mlmodelc")
        let jntUrl = bundleDir.appendingPathComponent("joint.mlmodelc")
        let vocabUrl = bundleDir.appendingPathComponent("vocab.json")
        let configUrl = bundleDir.appendingPathComponent("config.json")

        let encCfg = MLModelConfiguration()
        encCfg.computeUnits = .cpuAndNeuralEngine
        let decCfg = MLModelConfiguration()
        decCfg.computeUnits = .all

        self.encoder = try MLModel(contentsOf: encUrl, configuration: encCfg)
        self.decoder = try MLModel(contentsOf: decUrl, configuration: decCfg)
        self.joint = try MLModel(contentsOf: jntUrl, configuration: decCfg)

        // 1. 解析词表 vocab.json
        var maxTokenId = 0
        if let vData = try? Data(contentsOf: vocabUrl),
           let jsonObj = try? JSONSerialization.jsonObject(with: vData) {
            if let arr = jsonObj as? [String] {
                for (idx, piece) in arr.enumerated() {
                    vocab[idx] = piece
                    maxTokenId = max(maxTokenId, idx)
                }
            } else if let dict = jsonObj as? [String: Any] {
                if let pieces = dict["pieces"] as? [String] {
                    for (idx, piece) in pieces.enumerated() {
                        vocab[idx] = piece
                        maxTokenId = max(maxTokenId, idx)
                    }
                } else {
                    for (k, v) in dict {
                        if let idx = Int(k), let piece = v as? String {
                            vocab[idx] = piece
                            maxTokenId = max(maxTokenId, idx)
                        } else if let idx = v as? Int {
                            vocab[idx] = k
                            maxTokenId = max(maxTokenId, idx)
                        }
                    }
                }
            }
        }
        self.blankId = maxTokenId > 0 ? maxTokenId + 1 : 1024
        for (id, piece) in vocab {
            if piece == "<blank>" || piece == "<blk>" {
                self.blankId = id
            } else if piece == "<EOU>" || piece == "<eou>" {
                self.eouId = id
            }
        }

        // 2. 解析 config.json（若提供 blank_id / vocab_size / chunk_frames）
        var cfgMelBins = 80
        if let cData = try? Data(contentsOf: configUrl),
           let cDict = try? JSONSerialization.jsonObject(with: cData) as? [String: Any] {
            if let bId = cDict["blank_id"] as? Int ?? cDict["blank_idx"] as? Int {
                self.blankId = bId
            } else if let vSz = cDict["vocab_size"] as? Int {
                self.blankId = vSz - 1
            }
            if let eId = cDict["eou_id"] as? Int {
                self.eouId = eId
            }
            if let mBins = cDict["n_mels"] as? Int ?? cDict["mel_bins"] as? Int ?? cDict["num_mel_bins"] as? Int {
                cfgMelBins = mBins
            }
        }
        self.lastToken = self.blankId

        // 3. 动态内省 Encoder 输入张量，确定 Mel 形状与 Cache 初始状态
        var detectedMels = cfgMelBins
        let encInputs = encoder.modelDescription.inputDescriptionsByName
        for (name, desc) in encInputs {
            guard let constraint = desc.multiArrayConstraint else { continue }
            let shape = constraint.shape.map { $0.intValue }
            let lower = name.lowercased()
            if (lower.contains("audio") || lower.contains("mel") || lower.contains("signal") || lower.contains("feat") || lower == "x") && !lower.contains("len") && !lower.contains("cache") {
                self.melInputName = name
                if shape.count == 3 {
                    if shape[1] == 80 || shape[1] == 128 {
                        detectedMels = shape[1]
                        self.melFramesPerChunk = shape[2]
                        self.melChannelsFirst = true
                    } else if shape[2] == 80 || shape[2] == 128 {
                        detectedMels = shape[2]
                        self.melFramesPerChunk = shape[1]
                        self.melChannelsFirst = false
                    } else {
                        detectedMels = shape[1]
                        self.melFramesPerChunk = shape[2]
                        self.melChannelsFirst = true
                    }
                }
            } else if lower.contains("len") && !lower.contains("cache") {
                self.melLengthName = name
            }
        }

        // pre_cache 步进调整：若模型含 pre_cache 输入或 lookahead，仍按 16 帧 (160ms) 步进消费
        self.melConsumeFrames = min(self.melFramesPerChunk, 16)
        self.melExtractor = StreamingMelExtractor(nMels: detectedMels)

        try initStates(hard: true)
    }

    func initStates(hard: Bool) throws {
        accumulatedText = ""
        if hard {
            melExtractor.reset()
            lastToken = blankId
            encoderStates.removeAll()
            decoderStates.removeAll()

            for (name, desc) in encoder.modelDescription.inputDescriptionsByName {
                if name == melInputName || name == melLengthName { continue }
                if let c = desc.multiArrayConstraint, !c.shape.isEmpty {
                    encoderStates[name] = try Self.makeZeroArray(shape: c.shape, dataType: c.dataType)
                }
            }
            for (name, desc) in decoder.modelDescription.inputDescriptionsByName {
                let lower = name.lowercased()
                if lower.contains("target") || lower.contains("token") || lower.contains("input") || lower.contains("len") {
                    continue
                }
                if let c = desc.multiArrayConstraint, !c.shape.isEmpty {
                    decoderStates[name] = try Self.makeZeroArray(shape: c.shape, dataType: c.dataType)
                }
            }
        }
    }

    func pushPCM(_ samples: [Int16]) -> (text: String, delta: String, eou: Bool, latencyMs: Double) {
        let t0 = CFAbsoluteTimeGetCurrent()
        melExtractor.appendSamples(samples)

        var emittedDelta = ""
        var hitEOU = false

        while let melFrames = melExtractor.popMelFrames(count: melFramesPerChunk, consumeFrames: melConsumeFrames) {
            autoreleasepool {
                if let (chunkDelta, chunkEOU) = try? runSingleChunk(melFrames: melFrames) {
                    emittedDelta += chunkDelta
                    if chunkEOU { hitEOU = true }
                }
            }
        }

        if !emittedDelta.isEmpty {
            accumulatedText += emittedDelta
        }
        let cleanFull = Self.formatBpeText(accumulatedText)
        let cleanDelta = Self.formatBpeText(emittedDelta)
        let elapsedMs = (CFAbsoluteTimeGetCurrent() - t0) * 1000.0
        return (cleanFull, cleanDelta, hitEOU, Double(round(elapsedMs * 10) / 10))
    }

    private func runSingleChunk(melFrames: [[Float]]) throws -> (String, Bool) {
        let encInputs = encoder.modelDescription.inputDescriptionsByName
        guard let melConstraint = encInputs[melInputName]?.multiArrayConstraint else {
            return ("", false)
        }

        let melArray = try Self.makeZeroArray(shape: melConstraint.shape, dataType: melConstraint.dataType)
        let nMels = melExtractor.nMels
        let nFrames = melFrames.count

        for t in 0..<nFrames {
            for m in 0..<nMels {
                let val = NSNumber(value: melFrames[t][m])
                if melChannelsFirst {
                    melArray[[0, NSNumber(value: m), NSNumber(value: t)]] = val
                } else {
                    melArray[[0, NSNumber(value: t), NSNumber(value: m)]] = val
                }
            }
        }

        var feedDict: [String: Any] = [melInputName: melArray]
        if let lenName = melLengthName,
           let lenConstraint = encInputs[lenName]?.multiArrayConstraint {
            let lenArr = try Self.makeZeroArray(shape: lenConstraint.shape, dataType: lenConstraint.dataType)
            lenArr[0] = NSNumber(value: nFrames)
            feedDict[lenName] = lenArr
        }
        for (k, v) in encoderStates {
            feedDict[k] = v
        }

        let encOutProvider = try encoder.prediction(from: MLDictionaryFeatureProvider(dictionary: feedDict))

        // 更新 Encoder 缓存并提取编码特征张量
        var encodedFeature: MLMultiArray? = nil
        for outName in encoder.modelDescription.outputDescriptionsByName.keys {
            guard let arr = encOutProvider.featureValue(for: outName)?.multiArrayValue else { continue }
            if let matchedStateKey = Self.matchStateKey(outputName: outName, stateKeys: Array(encoderStates.keys), shape: arr.shape) {
                encoderStates[matchedStateKey] = arr
            } else if !outName.lowercased().contains("len") && !outName.lowercased().contains("cache") {
                encodedFeature = arr
            }
        }

        guard let encArr = encodedFeature else { return ("", false) }

        // 确定编码帧的时间步维度 (通常为 [1, D, T] 或 [1, T, D])
        let encShape = encArr.shape.map { $0.intValue }
        guard encShape.count == 3 else { return ("", false) }
        let encChannelsFirst = encShape[1] >= 256 && encShape[2] <= 32
        let timeSteps = encChannelsFirst ? encShape[2] : encShape[1]
        let encDim = encChannelsFirst ? encShape[1] : encShape[2]

        var chunkPieces = ""
        var chunkEOU = false

        for t in 0..<timeSteps {
            var symbolsEmitted = 0
            while symbolsEmitted < 5 {
                let (decOut, nextDecStates) = try runDecoderStep(token: lastToken)
                let logits = try runJointStep(encArr: encArr, timeIndex: t, encDim: encDim, encChannelsFirst: encChannelsFirst, decArr: decOut)

                let bestToken = Self.argmax(logits)
                if bestToken == blankId || bestToken < 0 {
                    break
                }
                if bestToken == eouId {
                    chunkEOU = true
                    break
                }

                decoderStates = nextDecStates
                lastToken = bestToken
                symbolsEmitted += 1

                if let piece = vocab[bestToken] {
                    if !piece.hasPrefix("<") || !piece.hasSuffix(">") {
                        chunkPieces += piece
                    }
                }
            }
        }

        return (chunkPieces, chunkEOU)
    }

    private func runDecoderStep(token: Int) throws -> (MLMultiArray, [String: MLMultiArray]) {
        let decInputs = decoder.modelDescription.inputDescriptionsByName
        var feed: [String: Any] = [:]

        for (name, desc) in decInputs {
            if let stateArr = decoderStates[name] {
                feed[name] = stateArr
                continue
            }
            guard let c = desc.multiArrayConstraint else { continue }
            let arr = try Self.makeZeroArray(shape: c.shape, dataType: c.dataType)
            if name.lowercased().contains("len") {
                arr[0] = NSNumber(value: 1)
            } else {
                arr[0] = NSNumber(value: token)
            }
            feed[name] = arr
        }

        let outProvider = try decoder.prediction(from: MLDictionaryFeatureProvider(dictionary: feed))
        var nextStates = decoderStates
        var decOut: MLMultiArray? = nil

        for outName in decoder.modelDescription.outputDescriptionsByName.keys {
            guard let arr = outProvider.featureValue(for: outName)?.multiArrayValue else { continue }
            if let stateKey = Self.matchStateKey(outputName: outName, stateKeys: Array(decoderStates.keys), shape: arr.shape) {
                nextStates[stateKey] = arr
            } else if !outName.lowercased().contains("len") {
                decOut = arr
            }
        }

        guard let validDecOut = decOut else {
            throw NSError(domain: "NemotronASR", code: -2, userInfo: [NSLocalizedDescriptionKey: "Missing decoder output"])
        }
        return (validDecOut, nextStates)
    }

    private func runJointStep(
        encArr: MLMultiArray,
        timeIndex: Int,
        encDim: Int,
        encChannelsFirst: Bool,
        decArr: MLMultiArray
    ) throws -> MLMultiArray {
        let jntInputs = joint.modelDescription.inputDescriptionsByName
        var feed: [String: Any] = [:]

        for (name, desc) in jntInputs {
            guard let c = desc.multiArrayConstraint else { continue }
            let lower = name.lowercased()
            if lower.contains("enc") || lower.contains("audio") || lower == "f" {
                let stepArr = try Self.makeZeroArray(shape: c.shape, dataType: c.dataType)
                for d in 0..<encDim {
                    let v: NSNumber = encChannelsFirst
                        ? encArr[[0, NSNumber(value: d), NSNumber(value: timeIndex)]]
                        : encArr[[0, NSNumber(value: timeIndex), NSNumber(value: d)]]
                    stepArr[d] = v
                }
                feed[name] = stepArr
            } else {
                // 对齐 Decoder 输出
                let stepArr = try Self.makeZeroArray(shape: c.shape, dataType: c.dataType)
                let count = min(stepArr.count, decArr.count)
                for i in 0..<count {
                    stepArr[i] = decArr[i]
                }
                feed[name] = stepArr
            }
        }

        let outProvider = try joint.prediction(from: MLDictionaryFeatureProvider(dictionary: feed))
        for outName in joint.modelDescription.outputDescriptionsByName.keys {
            if let arr = outProvider.featureValue(for: outName)?.multiArrayValue {
                return arr
            }
        }
        throw NSError(domain: "NemotronASR", code: -3, userInfo: [NSLocalizedDescriptionKey: "Missing joint output"])
    }

    private static func argmax(_ arr: MLMultiArray) -> Int {
        let count = arr.count
        guard count > 0 else { return -1 }
        var bestIdx = 0
        var bestVal = arr[0].floatValue
        for i in 1..<count {
            let v = arr[i].floatValue
            if v > bestVal {
                bestVal = v
                bestIdx = i
            }
        }
        return bestIdx
    }

    private static func matchStateKey(outputName: String, stateKeys: [String], shape: [NSNumber]) -> String? {
        let cleanOut = outputName
            .replacingOccurrences(of: "_out", with: "")
            .replacingOccurrences(of: "out_", with: "")
            .replacingOccurrences(of: "new_", with: "")
            .replacingOccurrences(of: "_next", with: "")
        if stateKeys.contains(cleanOut) {
            return cleanOut
        }
        for k in stateKeys {
            if outputName.hasPrefix(k) || k.hasPrefix(cleanOut) {
                return k
            }
        }
        return nil
    }

    private static func makeZeroArray(shape: [NSNumber], dataType: MLMultiArrayDataType) throws -> MLMultiArray {
        let arr = try MLMultiArray(shape: shape, dataType: dataType)
        let count = arr.count
        for i in 0..<count {
            arr[i] = 0
        }
        return arr
    }

    private static func formatBpeText(_ raw: String) -> String {
        return raw
            .replacingOccurrences(of: "\u{2581}", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - 守护进程入口

setbuf(stdout, nil)

let defaultBundleDir = NSString(
    string: "~/Library/Application Support/SimpleUI/models/subtitles_pipeline/nemotron_asr"
).expandingTildeInPath

let bundleUrl = URL(fileURLWithPath: defaultBundleDir)
var streamer: NemotronCoreMLStreamer? = nil
var initError: String? = nil

do {
    if FileManager.default.fileExists(atPath: bundleUrl.appendingPathComponent("encoder.mlmodelc").path) {
        streamer = try NemotronCoreMLStreamer(bundleDir: bundleUrl)
    } else {
        initError = "Nemotron CoreML model not found at \(defaultBundleDir)"
    }
} catch {
    initError = "Failed to load Nemotron CoreML bundle: \(error.localizedDescription)"
}

print("READY")

let encoder = JSONEncoder()
let decoder = JSONDecoder()

while let line = readLine() {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }

    guard let reqData = trimmed.data(using: .utf8),
          let req = try? decoder.decode(CommandRequest.self, from: reqData) else {
        print("{\"ok\":false,\"text\":\"\",\"delta\":\"\",\"eou\":false,\"npu_latency_ms\":0,\"hardware\":\"ANE\",\"error\":\"Invalid JSON\"}")
        continue
    }

    guard let engine = streamer else {
        let errMsg = initError ?? "Engine not initialized"
        let resp = StreamResponse(ok: false, text: "", delta: "", eou: false, npu_latency_ms: 0, hardware: "ANE", error: errMsg)
        if let out = try? encoder.encode(resp), let s = String(data: out, encoding: .utf8) {
            print(s)
        }
        continue
    }

    let cmd = req.cmd ?? "push"
    if cmd == "reset" {
        try? engine.initStates(hard: req.hard ?? false)
        let resp = StreamResponse(ok: true, text: "", delta: "", eou: false, npu_latency_ms: 0, hardware: "Apple Neural Engine (16-Core NPU)", error: nil)
        if let out = try? encoder.encode(resp), let s = String(data: out, encoding: .utf8) {
            print(s)
        }
        continue
    }

    var pcmSamples: [Int16] = []
    if let b64 = req.pcm_b64, let rawData = Data(base64Encoded: b64) {
        let count = rawData.count / 2
        pcmSamples = rawData.withUnsafeBytes { ptr in
            let int16Ptr = ptr.bindMemory(to: Int16.self)
            return Array(int16Ptr.prefix(count))
        }
    } else if let wavPath = req.wav, let wavData = try? Data(contentsOf: URL(fileURLWithPath: wavPath)), wavData.count > 44 {
        let pcmData = wavData.subdata(in: 44..<wavData.count)
        let count = pcmData.count / 2
        pcmSamples = pcmData.withUnsafeBytes { ptr in
            let int16Ptr = ptr.bindMemory(to: Int16.self)
            return Array(int16Ptr.prefix(count))
        }
    }

    let result = engine.pushPCM(pcmSamples)
    let resp = StreamResponse(
        ok: true,
        text: result.text,
        delta: result.delta,
        eou: result.eou,
        npu_latency_ms: result.latencyMs,
        hardware: "Apple Neural Engine (16-Core NPU)",
        error: nil
    )
    if let out = try? encoder.encode(resp), let s = String(data: out, encoding: .utf8) {
        print(s)
    }
}
