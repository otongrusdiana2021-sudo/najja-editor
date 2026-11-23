// Test video like the server's light copy: H.264 Main 1280x720 30 fps, keyframe every 15 frames, no B-frames,
// moov at the front, AAC stereo. Every frame shows its number and a white bar at x = (frame % 30).
import AVFoundation
import AppKit
import CoreText

let out = URL(fileURLWithPath: CommandLine.arguments[1])
let secs = Double(CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "40") ?? 40
try? FileManager.default.removeItem(at: out)
let w = 1280, h = 720
let writer = try! AVAssetWriter(outputURL: out, fileType: .mp4)
writer.shouldOptimizeForNetworkUse = true
let vset: [String: Any] = [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h,
  AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 2_500_000, AVVideoMaxKeyFrameIntervalKey: 15,
    AVVideoAllowFrameReorderingKey: false, AVVideoProfileLevelKey: AVVideoProfileLevelH264MainAutoLevel, AVVideoExpectedSourceFrameRateKey: 30]]
let vin = AVAssetWriterInput(mediaType: .video, outputSettings: vset)
vin.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vin, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h])
writer.add(vin)
let ain = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 128000])
ain.expectsMediaDataInRealTime = false
writer.add(ain)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

// sound: 440 Hz with a 1 kHz beep at every whole second of the file
var asbd = AudioStreamBasicDescription(mSampleRate: 48000, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
  mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2, mBitsPerChannel: 16, mReserved: 0)
var fmt: CMAudioFormatDescription?
CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &fmt)
let total = Int(secs * 48000)
var pos = 0
func audioUpTo(_ upTo: Int) {
while pos < min(total, upTo) {
  while !ain.isReadyForMoreMediaData { usleep(1000) }
  let count = min(1024, total - pos)
  var data = [Int16](repeating: 0, count: count * 2)
  for k in 0..<count {
    let t = Double(pos + k) / 48000
    var v = 0.15 * sin(2 * .pi * 440 * t)
    if t - floor(t) < 0.03 { v += 0.6 * sin(2 * .pi * 1000 * t) }
    let s = Int16(max(-1, min(1, v)) * 32767)
    data[2 * k] = s; data[2 * k + 1] = s
  }
  var block: CMBlockBuffer?
  let bytes = count * 4
  CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil, customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: 0, blockBufferOut: &block)
  _ = data.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: bytes) }
  var sb: CMSampleBuffer?
  CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!, formatDescription: fmt!, sampleCount: count,
    presentationTimeStamp: CMTime(value: CMTimeValue(pos), timescale: 48000), packetDescriptions: nil, sampleBufferOut: &sb)
  ain.append(sb!)
  pos += count
}
}

let n = Int(secs * 30)
for i in 0..<n {
  while !vin.isReadyForMoreMediaData { usleep(1000) }
  var pb: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
  CVPixelBufferLockBaseAddress(pb!, [])
  let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb!), width: w, height: h, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pb!),
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
  let hue = CGFloat((i / 30) % 12) / 12
  ctx.setFillColor(NSColor(hue: hue, saturation: 0.6, brightness: 0.45, alpha: 1).cgColor)
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.setFillColor(NSColor.white.cgColor)
  ctx.fill(CGRect(x: CGFloat(i % 30) * CGFloat(w) / 30, y: 40, width: CGFloat(w) / 30, height: 80)) // bottom band (CG origin bottom-left)
  let text = String(format: "F%04d  %06.3fs", i, Double(i) / 30)
  let attr = NSAttributedString(string: text, attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 110, weight: .bold), .foregroundColor: NSColor.white])
  ctx.textPosition = CGPoint(x: 80, y: 330)
  CTLineDraw(CTLineCreateWithAttributedString(attr), ctx)
  CVPixelBufferUnlockBaseAddress(pb!, [])
  adaptor.append(pb!, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: 30))
  audioUpTo((i + 1) * 1600)
}
audioUpTo(total)
vin.markAsFinished()

ain.markAsFinished()
let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()
print("status", writer.status.rawValue, writer.error.map { "\($0)" } ?? "ok")
