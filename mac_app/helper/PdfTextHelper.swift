import Foundation
import PDFKit

/// PDF 文本抽取 helper（供 server/folder_index 逐页取文）。
///
/// 用法：
///   pdftext <path>            逐页输出 JSONL：{"p":1,"t":"..."}
///   pdftext --probe <path>    只输出元信息：{"pages":42,"chars":18623,"empty":0}
///
/// 为什么单独一个可执行文件而不是在 Node 里做：
///   PDF 的中文文本层只有 PDFKit 解得干净（Core Graphics 层），
///   第三方 JS 库要么丢字要么把断行粘错；这里和 subtitle_ml_helper 用同一套
///   「编译成 bin/ 随包分发 + stdin/stdout 交互」的做法。
///
/// 输出必须是一行一个 JSON —— 调用方按行解析，任何多余日志都会污染管道。
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes]),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

let args = Array(CommandLine.arguments.dropFirst())
guard !args.isEmpty else {
    FileHandle.standardError.write(Data("usage: pdftext [--probe] <file>\n".utf8))
    exit(2)
}

let probe = args.first == "--probe"
let path = probe ? args[1] : args[0]

guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
    emit(["error": "unreadable"])
    exit(1)
}

if probe {
    var chars = 0
    var empty = 0
    for i in 0..<doc.pageCount {
        let t = doc.page(at: i)?.string ?? ""
        chars += t.count
        if t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { empty += 1 }
    }
    emit(["pages": doc.pageCount, "chars": chars, "empty": empty])
    exit(0)
}

for i in 0..<doc.pageCount {
    let t = doc.page(at: i)?.string ?? ""
    if t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
    emit(["p": i + 1, "t": t])
}
