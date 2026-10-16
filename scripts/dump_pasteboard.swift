import AppKit
import Foundation

let pb = NSPasteboard.general
print("=== NSPasteboard Dump ===")
let items = pb.pasteboardItems ?? []
if items.isEmpty {
    print("Pasteboard is currently empty.")
} else {
    for (i, item) in items.enumerated() {
        print("\n--- Pasteboard Item \(i) ---")
        for t in item.types {
            let data = item.data(forType: t)
            let byteCount = data?.count ?? 0
            print("Type: \(t.rawValue) (\(byteCount) bytes)")
            
            // Preview readable text / XML / HTML
            if let d = data, let text = String(data: d, encoding: .utf8) {
                let preview = text.replacingOccurrences(of: "\n", with: " ")
                let truncated = preview.count > 120 ? String(preview.prefix(120)) + "..." : preview
                print("   Preview: \(truncated)")
            }
        }
    }
}
print("\n=== End Dump ===")
