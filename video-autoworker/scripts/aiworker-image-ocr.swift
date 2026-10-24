#!/usr/bin/swift
// Offline OCR only. No rendering, network access, or source modification.
import Foundation
import ImageIO
import Vision

func stop(_ code: String) -> Never {
    let value: [String: Any] = ["currentState": "FAILED", "errorCode": code]
    if let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardError.write(bytes)
        FileHandle.standardError.write(Data([10]))
    }
    exit(1)
}

guard CommandLine.arguments.count == 2 else { stop("image_ocr_arguments_invalid") }
let path = CommandLine.arguments[1]
guard path.hasPrefix("/"), !path.split(separator: "/").contains("..") else {
    stop("image_ocr_input_invalid")
}
guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
      let type = attributes[.type] as? FileAttributeType, type == .typeRegular,
      let size = attributes[.size] as? NSNumber, size.intValue > 0,
      size.intValue <= 40 * 1024 * 1024 else { stop("image_ocr_input_invalid") }
let url = URL(fileURLWithPath: path)
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      CGImageSourceGetType(source) as String? == "public.png",
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    stop("image_ocr_input_invalid")
}
let width = image.width, height = image.height
guard width > 0, height > 0, width <= 8192, height <= 8192,
      width * height <= 24 * 1024 * 1024 else { stop("image_ocr_input_invalid") }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false
request.minimumTextHeight = 0.005
let handler = VNImageRequestHandler(cgImage: image, options: [:])
do { try handler.perform([request]) } catch { stop("image_ocr_failed") }

var lines: [[String: Any]] = []
for observation in (request.results ?? []).prefix(512) {
    guard let candidate = observation.topCandidates(1).first,
          !candidate.string.isEmpty, candidate.string.count <= 1024 else { continue }
    let rectangle = observation.boundingBox
    let left = max(0, Int(floor(rectangle.minX * Double(width))))
    let top = max(0, Int(floor((1 - rectangle.maxY) * Double(height))))
    let right = min(width, Int(ceil(rectangle.maxX * Double(width))))
    let bottom = min(height, Int(ceil((1 - rectangle.minY) * Double(height))))
    guard right > left, bottom > top else { continue }
    lines.append(["text": candidate.string, "confidence": Double(candidate.confidence),
                  "box": [left, top, right - left, bottom - top]])
}
lines.sort {
    let a = $0["box"] as! [Int], b = $1["box"] as! [Int]
    return a[1] != b[1] ? a[1] < b[1] : a[0] < b[0]
}
let value: [String: Any] = ["engine": "apple-vision", "width": width, "height": height,
                          "lines": lines]
guard let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
    stop("image_ocr_result_invalid")
}
FileHandle.standardOutput.write(bytes)
FileHandle.standardOutput.write(Data([10]))
