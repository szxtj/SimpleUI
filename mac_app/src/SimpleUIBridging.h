//
// SimpleUI Swift ↔ ObjC 桥接头
//
// 只为了一个目的：把 AVAudioEngine 抛出的 **ObjC 异常** 收在 @try/@catch 里。
// Swift 没有异常捕获语法，`installTap` 抛出的 NSException 会直接 abort 掉整个 App
// （2026-10-25 实测崩溃：AVAudioEngineGraph::InstallTapOnNode → abort）。
//
#import "AudioTapGuard.h"
