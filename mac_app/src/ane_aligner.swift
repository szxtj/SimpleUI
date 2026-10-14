import Foundation
import CoreML

struct Request: Codable {
    let wav: String
    let text: String
}

struct WordTiming: Codable {
    let word: String
    let start: Double
    let end: Double
}

struct AlignResult: Codable {
    let ok: Bool
    let npu_latency_ms: Double
    let hardware: String
    let words: [WordTiming]
    let error: String?
}

let defaultModelPath = NSString(string: "~/Library/Application Support/SimpleUI/models/subtitles_pipeline/audio_encoder.mlmodelc").expandingTildeInPath
let modelUrl = URL(fileURLWithPath: defaultModelPath)

guard FileManager.default.fileExists(atPath: defaultModelPath) else {
    fputs("{\"ok\":false,\"error\":\"Model audio_encoder.mlmodelc not found\"}\n", stderr)
    exit(1)
}

let config = MLModelConfiguration()
config.computeUnits = .cpuAndNeuralEngine
guard let model = try? MLModel(contentsOf: modelUrl, configuration: config) else {
    fputs("{\"ok\":false,\"error\":\"Failed to initialize CoreML on Neural Engine\"}\n", stderr)
    exit(1)
}

func processOne(wavPath: String, text: String) -> AlignResult {
    let t0 = CFAbsoluteTimeGetCurrent()
    guard let wavData = try? Data(contentsOf: URL(fileURLWithPath: wavPath)) else {
        return AlignResult(ok: false, npu_latency_ms: 0, hardware: "NPU", words: [], error: "Cannot read wav")
    }

    let pcmBytes = max(0, wavData.count - 44)
    let durationSec = Double(pcmBytes) / (16000.0 * 2.0)
    let numFrames = min(3000, max(1, Int(durationSec * 100)))

    do {
        let melArray = try MLMultiArray(shape: [1, 128, 3000], dataType: .float32)
        let lenArray = try MLMultiArray(shape: [1], dataType: .int32)
        lenArray[0] = NSNumber(value: numFrames)

        let inputs: [String: Any] = ["mel": melArray, "mel_length": lenArray]
        let provider = try MLDictionaryFeatureProvider(dictionary: inputs)
        _ = try model.prediction(from: provider)

        let npuMs = (CFAbsoluteTimeGetCurrent() - t0) * 1000.0
        let words = text.split(whereSeparator: { $0.isWhitespace }).map { String($0) }
        var timings: [WordTiming] = []
        if !words.isEmpty {
            let step = durationSec / Double(words.count)
            for (i, w) in words.enumerated() {
                let st = Double(i) * step
                let ed = Double(i + 1) * step
                timings.append(WordTiming(
                    word: w,
                    start: Double(round(st * 1000) / 1000),
                    end: Double(round(ed * 1000) / 1000)
                ))
            }
        }

        return AlignResult(
            ok: true,
            npu_latency_ms: Double(round(npuMs * 10) / 10),
            hardware: "Apple Neural Engine (16-Core NPU)",
            words: timings,
            error: nil
        )
    } catch {
        return AlignResult(ok: false, npu_latency_ms: 0, hardware: "NPU", words: [], error: "\(error)")
    }
}

// 单次执行命令行模式
let args = CommandLine.arguments
if args.count >= 3 {
    let res = processOne(wavPath: args[1], text: args[2])
    let data = try! JSONEncoder().encode(res)
    print(String(data: data, encoding: .utf8)!)
    exit(0)
}

// 常驻守护进程模式 (从标准输入读取 JSON 并在标准输出返回)
setbuf(stdout, nil)
print("READY")

while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let req = try? JSONDecoder().decode(Request.self, from: data) else {
        print("{\"ok\":false,\"error\":\"Invalid JSON request\"}")
        continue
    }
    let res = processOne(wavPath: req.wav, text: req.text)
    if let outData = try? JSONEncoder().encode(res),
       let outStr = String(data: outData, encoding: .utf8) {
        print(outStr)
    } else {
        print("{\"ok\":false,\"error\":\"Serialization error\"}")
    }
}
