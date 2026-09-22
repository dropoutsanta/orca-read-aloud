import Carbon
import Darwin
import Foundation

let lockPath = "/tmp/read-aloud-stop-hotkey.lock"
let fd = open(lockPath, O_CREAT | O_RDWR, 0o644)
if fd < 0 || flock(fd, LOCK_EX | LOCK_NB) != 0 {
    exit(0)
}

func stopSpeech() {
    let url = URL(string: "http://127.0.0.1:47321/api/stop")!
    var request = URLRequest(url: url, timeoutInterval: 0.4)
    request.httpMethod = "POST"
    request.httpBody = Data("{}".utf8)
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { _, _, _ in
        done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 0.5)
    killSpeechChildren()
}

func killSpeechChildren() {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/ps")
    task.arguments = ["-axo", "pid=,ppid=,command="]
    let pipe = Pipe()
    task.standardOutput = pipe
    try? task.run()
    task.waitUntilExit()
    let text = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    var parentOf = [Int32: Int32]()
    var commandOf = [Int32: String]()
    for line in text.split(separator: "\n") {
        let parts = line.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
        guard parts.count >= 2, let pid = Int32(parts[0]), let parent = Int32(parts[1]) else { continue }
        parentOf[pid] = parent
        commandOf[pid] = parts.count == 3 ? String(parts[2]) : ""
    }
    let hosts = Set(commandOf.compactMap { pid, command -> Int32? in
        command.contains("plugin-host-entry.js") ? pid : nil
    })
    func belongsToPlugin(_ pid: Int32) -> Bool {
        var current = parentOf[pid] ?? 0
        var hops = 0
        while current > 1 && hops < 20 {
            if hosts.contains(current) { return true }
            current = parentOf[current] ?? 0
            hops += 1
        }
        return false
    }
    for (pid, command) in commandOf where belongsToPlugin(pid) {
        if command.contains("/usr/bin/say") || command.contains("/.local/bin/claude") || command.contains("/claude -p") {
            kill(pid, SIGTERM)
        }
    }
}

var hotKey = EventHotKeyID(signature: OSType(0x52414C44), id: 1)
var hotKeyRef: EventHotKeyRef?
let registered = RegisterEventHotKey(
    UInt32(kVK_ANSI_X),
    UInt32(cmdKey | optionKey),
    hotKey,
    GetApplicationEventTarget(),
    0,
    &hotKeyRef
)
if registered != noErr {
    fputs("could not register option-command-x (\(registered))\n", stderr)
    exit(1)
}

var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
    stopSpeech()
    return noErr
}, 1, &spec, nil, nil)

RunLoop.main.run()
