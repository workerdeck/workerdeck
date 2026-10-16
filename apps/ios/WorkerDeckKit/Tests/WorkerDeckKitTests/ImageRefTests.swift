import Foundation
import Testing

@testable import WorkerDeckKit

@Suite("ImageRefs")
struct ImageRefTests {
  @Test("decoded size comes out of the base64 length and its padding")
  func base64Arithmetic() {
    // Computed, never decoded: measuring a 665 KB screenshot by decoding it is
    // the allocation this whole rule exists to avoid.
    #expect(base64DecodedBytes("") == 0)
    #expect(base64DecodedBytes("AAAA") == 3)  // no padding
    #expect(base64DecodedBytes("AAA=") == 2)  // one pad byte
    #expect(base64DecodedBytes("AA==") == 1)  // two
    // And against a real payload, which is the only check that catches a
    // fencepost: whatever `Data` actually decodes to is what the gateway
    // stamped.
    let bytes = Data((0..<1000).map { UInt8($0 % 251) })
    for trim in 0..<3 {
      let payload = bytes.prefix(bytes.count - trim)
      let encoded = payload.base64EncodedString()
      #expect(base64DecodedBytes(encoded) == payload.count)
    }
  }

  @Test("the placeholder spells the size the gateway stamped")
  func placeholderSpelling() {
    // One spelling, shared with the web client's `imagePlaceholder`: this
    // string is what the box says before the fetch lands, and the phone and the
    // dashboard must not describe the same screenshot differently.
    #expect(TermImage.placeholder(bytes: 343_040) == "image · 335.0 KB")
    #expect(TermImage.unavailable == "image unavailable")
    #expect(TermImage.boxLines == 12)
  }
}
