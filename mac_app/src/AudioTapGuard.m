#import "AudioTapGuard.h"

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

BOOL SUIAudioInstallTap(AVAudioNode *node,
                        AVAudioNodeBus bus,
                        AVAudioFrameCount bufferSize,
                        AVAudioNodeTapBlock tapBlock,
                        NSString *_Nullable *_Nullable outError) {
    if (!node || !tapBlock) {
        if (outError) *outError = @"node/tapBlock 为空";
        return NO;
    }
    @try {
        [node installTapOnBus:bus bufferSize:bufferSize format:nil block:tapBlock];
        return YES;
    } @catch (NSException *e) {
        if (outError) {
            *outError = [NSString stringWithFormat:@"%@: %@", e.name ?: @"NSException", e.reason ?: @"(no reason)"];
        }
        return NO;
    }
}

void SUIAudioRemoveTap(AVAudioNode *node, AVAudioNodeBus bus) {
    if (!node) return;
    @try {
        [node removeTapOnBus:bus];
    } @catch (NSException *e) {
        NSLog(@"[VoiceInput] ⚠ removeTap 抛异常(%@): %@", e.name, e.reason);
    }
}

#pragma clang diagnostic pop
