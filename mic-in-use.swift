import CoreAudio
import Foundation

// Prints "yes" when the default input device is running in any process
// (the orange microphone indicator), otherwise "no".

var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)
var device = AudioDeviceID(0)
var size = UInt32(MemoryLayout<AudioDeviceID>.size)
let system = AudioObjectID(kAudioObjectSystemObject)
guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &device) == noErr, device != 0 else {
    print("no")
    exit(0)
}

var running: UInt32 = 0
size = UInt32(MemoryLayout<UInt32>.size)
address.mSelector = kAudioDevicePropertyDeviceIsRunningSomewhere
guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &running) == noErr else {
    print("no")
    exit(0)
}
print(running == 0 ? "no" : "yes")
