// Check a PDF saved from the print dialog of the large-document QA run:
//
//     swift scripts/macos-qa/verify-large-print.swift output.pdf print-1024k.md
//
// The first, middle and last section headings of the fixture must be printed,
// in that order through the document.
import Foundation
import PDFKit

guard CommandLine.arguments.count == 3,
      let pdf = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])),
      let source = try? String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8) else { exit(2) }
let headings = source.split(separator: "\n").filter { $0.hasPrefix("## Section ") }.map { String($0.dropFirst(3)) }
guard headings.count > 2, pdf.pageCount > 2 else {
    print("Expected a multi-page PDF of a fixture with sections.")
    exit(1)
}
func squeeze(_ text: String) -> String { text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ") }
func pages(_ range: ClosedRange<Int>) -> String {
    squeeze(range.compactMap { pdf.page(at: $0)?.string }.joined(separator: " "))
}
let count = pdf.pageCount
let middle = count / 2, margin = max(3, count / 20)
let checks = [
    ("first", headings.first!, pages(0...min(2, count - 1))),
    ("middle", headings[headings.count / 2], pages(max(0, middle - margin)...min(count - 1, middle + margin))),
    ("last", headings.last!, pages(max(0, count - 3)...(count - 1))),
]
for (place, heading, text) in checks where !text.contains(squeeze(heading)) {
    print("The \(place) section, \"\(heading)\", is missing from its part of the \(count)-page PDF.")
    exit(1)
}
print("Verified the first, middle and last of \(headings.count) sections across \(count) pages.")
