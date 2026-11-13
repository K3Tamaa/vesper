import CoreGraphics
import Foundation

let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for window in list {
    let owner = window[kCGWindowOwnerName as String] as? String ?? ""
    guard owner == "Vesper" else { continue }
    let number = window[kCGWindowNumber as String] as? Int ?? 0
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let x = bounds["X"] as? Double ?? 0
    let y = bounds["Y"] as? Double ?? 0
    print("\(number) \(Int(x)) \(Int(y)) \(Int(bounds["Width"] as? Double ?? 0)) \(Int(bounds["Height"] as? Double ?? 0))")
}
