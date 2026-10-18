import Foundation
import CoreML

// 双语字幕 CoreML helper：
// - segment：输入 XLM-R token ids，返回 SaT 每个 token 的句界概率
// - turn：输入最近 8s 16kHz mono Int16 PCM，返回 Smart Turn “说完了”的概率
//
// 该 helper 只做模型推理；分词、断句、翻译、ASR 生命周期全部在 Node 侧。
// 任何模型加载/推理/协议错误都会以非零退出，Node 侧统一转成 fatal。

struct HelperError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(("subtitle_ml_helper: " + message + "\n").data(using: .utf8)!)
    exit(1)
}

func writeJSON(_ obj: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          let line = String(data: data, encoding: .utf8) else {
        fail("failed to encode JSON response")
    }
    print(line)
    fflush(stdout)
}

func argumentValue(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let idx = args.firstIndex(of: name), idx + 1 < args.count else { return nil }
    return args[idx + 1]
}

guard let modelsDir = argumentValue("--models-dir") else {
    fail("missing --models-dir")
}

let modelsURL = URL(fileURLWithPath: modelsDir, isDirectory: true)
let satURL = modelsURL.appendingPathComponent("SaT.mlmodelc", isDirectory: true)
let turnURL = modelsURL.appendingPathComponent("smart_turn.mlmodelc", isDirectory: true)

let config = MLModelConfiguration()
// 明确不使用 GPU：ASR / 翻译在 Metal 上，断句/端点放 ANE + CPU。
config.computeUnits = .cpuAndNeuralEngine

let satModel: MLModel
let turnModel: MLModel
do {
    satModel = try MLModel(contentsOf: satURL, configuration: config)
    turnModel = try MLModel(contentsOf: turnURL, configuration: config)
} catch {
    fail("failed to load CoreML models: \(error.localizedDescription)")
}

let satSize = 512
let turnSize = 128_000

let satInputIds: MLMultiArray
let satAttentionMask: MLMultiArray
let turnAudio: MLMultiArray
do {
    satInputIds = try MLMultiArray(shape: [1, NSNumber(value: satSize)], dataType: .int32)
    satAttentionMask = try MLMultiArray(shape: [1, NSNumber(value: satSize)], dataType: .int32)
    turnAudio = try MLMultiArray(shape: [1, NSNumber(value: turnSize)], dataType: .float32)
} catch {
    fail("failed to allocate CoreML input arrays: \(error)")
}

func runSat(ids: [Int]) throws -> [Float] {
    guard ids.count <= satSize - 2 else {
        throw HelperError(message: "SAT_INPUT_TOO_LONG")
    }
    let sequence = [0] + ids + [2] // XLM-R: <s> ... </s>
    for i in 0..<satSize {
        satInputIds[i] = NSNumber(value: i < sequence.count ? Int32(sequence[i]) : 1) // pad id
        satAttentionMask[i] = NSNumber(value: i < sequence.count ? 1 : 0)
    }
    let input = try MLDictionaryFeatureProvider(dictionary: [
        "input_ids": MLFeatureValue(multiArray: satInputIds),
        "attention_mask": MLFeatureValue(multiArray: satAttentionMask),
    ])
    let output = try satModel.prediction(from: input)
    guard let logits = output.featureValue(for: "logits")?.multiArrayValue else {
        throw HelperError(message: "SAT_OUTPUT_MISSING")
    }
    var probs = [Float](repeating: 0, count: sequence.count)
    for i in 0..<sequence.count {
        let x = logits[i].floatValue
        probs[i] = 1.0 / (1.0 + exp(-x))
    }
    return probs
}

func runTurn(pcm: Data) throws -> Float {
    guard pcm.count % 2 == 0 else {
        throw HelperError(message: "TURN_PCM_ODD_BYTES")
    }
    let samples: [Int16] = pcm.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return [] }
        let ptr = base.bindMemory(to: Int16.self, capacity: pcm.count / 2)
        return Array(UnsafeBufferPointer(start: ptr, count: pcm.count / 2))
    }
    for i in 0..<turnSize { turnAudio[i] = 0 }
    let take = min(samples.count, turnSize)
    let offset = turnSize - take
    for i in 0..<take {
        turnAudio[offset + i] = NSNumber(value: Float(samples[samples.count - take + i]) / 32768.0)
    }
    let input = try MLDictionaryFeatureProvider(dictionary: [
        "audio": MLFeatureValue(multiArray: turnAudio)
    ])
    let output = try turnModel.prediction(from: input)
    guard let prob = output.featureValue(for: "probability")?.multiArrayValue else {
        throw HelperError(message: "TURN_OUTPUT_MISSING")
    }
    return prob[0].floatValue
}

// 预热：CoreML 首次 prediction 会编译/放置算子，必须在 ready 之前完成。
do {
    _ = try runSat(ids: [6])
    _ = try runTurn(pcm: Data(count: 3200)) // 100ms 静音
} catch {
    fail("warmup failed: \(error)")
}

writeJSON(["ready": true, "satSize": satSize, "turnSize": turnSize])

while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        fail("invalid JSON command")
    }
    let id = obj["id"] ?? NSNull()
    guard let cmd = obj["cmd"] as? String else {
        writeJSON(["id": id, "error": "MISSING_CMD"])
        exit(1)
    }
    do {
        switch cmd {
        case "segment":
            guard let ids = obj["ids"] as? [Int] else {
                throw HelperError(message: "MISSING_IDS")
            }
            let probs = try runSat(ids: ids)
            writeJSON(["id": id, "probs": probs.map { Double($0) }])
        case "turn":
            guard let pcmBase64 = obj["pcm"] as? String,
                  let pcm = Data(base64Encoded: pcmBase64) else {
                throw HelperError(message: "INVALID_PCM")
            }
            let prob = try runTurn(pcm: pcm)
            writeJSON(["id": id, "probability": Double(prob)])
        case "ping":
            writeJSON(["id": id, "ok": true])
        default:
            throw HelperError(message: "UNKNOWN_CMD")
        }
    } catch {
        writeJSON(["id": id, "error": String(describing: error)])
        exit(1)
    }
}
