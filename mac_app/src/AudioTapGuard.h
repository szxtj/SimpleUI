#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>

NS_ASSUME_NONNULL_BEGIN

/// 在 @try/@catch 前提下安装音频 tap。
///
/// 为什么不直接调 `installTap`：AVAudioEngine 在 tap 安装失败时抛的是 **ObjC 异常**
/// （实测 macOS 27 上重复安装会抛 `com.apple.coreaudio.avfaudio` /
/// `required condition is false: nullptr == Tap()`），Swift 的 do/catch **抓不到**，
/// 会一路走到 abort()。这里把它降级成「返回 NO + 错误文本」，调用方据此走失败分支。
BOOL SUIAudioInstallTap(AVAudioNode *node,
                        AVAudioNodeBus bus,
                        AVAudioFrameCount bufferSize,
                        AVAudioNodeTapBlock tapBlock,
                        NSString *_Nullable *_Nullable outError);

/// 移除 tap。对没有 tap 的 bus 调用是安全的（实测），任何异常也只记日志不上抛。
void SUIAudioRemoveTap(AVAudioNode *node, AVAudioNodeBus bus);

NS_ASSUME_NONNULL_END
